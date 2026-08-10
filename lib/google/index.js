'use strict';

const assert = require('assert');
const jwt = require('./jwt');
const apiUrls = require('./urls');
const https = require('../https');

function parseResult(resultString, payment, resultStringV2) {
	const result = JSON.parse(resultString);
	const resultV2 = resultStringV2 ? JSON.parse(resultStringV2) : null;
	const purchaseTimeMillis = result.startTimeMillis || result.purchaseTimeMillis;
	const purchaseDate = purchaseTimeMillis ? parseInt(purchaseTimeMillis, 10) : null;
	const expirationDate = result.expiryTimeMillis ? parseInt(result.expiryTimeMillis, 10) : null;

	return {
		receipt: result,
		receiptV2: resultV2,
		transactionId: result.orderId,
		productId: payment.productId,
		purchaseDate,
		expirationDate
	};
}

function validatePaymentAndParseKeyObject(payment, productIdOptional) {
	let keyObject;

	assert.equal(typeof payment.packageName, 'string', 'Package name must be a string');
	if (!productIdOptional || (payment.productId !== undefined && payment.productId !== null)) {
		assert.equal(typeof payment.productId, 'string', 'Product ID must be a string');
	}
	assert.equal(typeof payment.receipt, 'string', 'Receipt must be a string');

	if (typeof payment.keyObject === 'string' || Buffer.isBuffer(payment.keyObject)) {
		keyObject = JSON.parse(payment.keyObject);
	} else {
		keyObject = payment.keyObject;
	}

	assert(keyObject, 'Google API key object must be provided');
	assert.equal(typeof keyObject, 'object', 'Google API key object must be an object');
	assert.equal(typeof keyObject.client_email, 'string', 'Google API client_email must be a string');
	assert.equal(typeof keyObject.private_key, 'string', 'Google API private_key must be a string');

	return keyObject;
}

function validateDeferralInfo(deferralInfo) {
	assert.equal(typeof deferralInfo, 'object', 'deferralInfo must be an object');
	assert.equal(typeof deferralInfo.expectedExpiryTimeMillis, 'number', 'expectedExpiryTimeMillis must be a number');
	assert.equal(typeof deferralInfo.desiredExpiryTimeMillis, 'number', 'desiredExpiryTimeMillis must be a number');

	assert(deferralInfo.desiredExpiryTimeMillis > deferralInfo.expectedExpiryTimeMillis, 'desiredExpiryTimeMillis must be greater than expectedExpiryTimeMillis');

	return deferralInfo;
}

// The docs say lineItems[0].productId replaces the v1 subscriptionId, but that
// only holds while a subscription has a single line item. While a plan change is
// in flight Play returns two, in no guaranteed order:
//
//  - the item that owns the current billing period, which carries expiryTime;
//  - the item queued to replace it, which has no expiryTime but does carry the
//    recurring price of the plan to come (it comes first on a deferred change).
//
// On a token that has already been replaced both items carry the same
// expiryTime, and only the plan actually held keeps a recurring price -- the
// incoming one is a proration stub with an empty autoRenewingPlan.
function resolveCurrentLineItem(lineItems) {
	const items = (Array.isArray(lineItems) ? lineItems : []).filter(function (lineItem) {
		return lineItem && typeof lineItem.productId === 'string' && lineItem.productId;
	});
	const current = items.filter(function (lineItem) {
		return lineItem.expiryTime;
	});
	const priced = current.filter(function (lineItem) {
		return lineItem.autoRenewingPlan && lineItem.autoRenewingPlan.recurringPrice;
	});

	// Prepaid plans and pending purchases have no expiryTime on any item, so
	// there is nothing better than the documented first-item behaviour.
	return priced[0] || current[0] || items[0] || null;
}


exports.verifyPayment = function (payment, cb) {
	let keyObject;

	try {
		// The product ID is only required up front for one-off products. For
		// subscriptions it is resolved from the v2 purchase itself.
		keyObject = validatePaymentAndParseKeyObject(payment, payment.subscription === true);
	} catch (error) {
		return process.nextTick(function () {
			cb(error);
		});
	}

	jwt.getToken(keyObject.client_email, keyObject.private_key, apiUrls.publisherScope, function (error, token) {
		if (error) {
			return cb(error);
		}

		// Fetches the v1 subscription/product purchase and hands the combined
		// result (optionally including the already fetched v2 purchase) back.
		function getV1(productId, resultStringV2) {
			const requestUrl = payment.subscription ?
				apiUrls.purchasesSubscriptionsGet(
					payment.packageName,
					productId,
					payment.receipt,
					token
				) :
				apiUrls.purchasesProductsGet(
					payment.packageName,
					productId,
					payment.receipt,
					token
				);

			return https.get(requestUrl, null, function (errorV1, res, resultString) {
				if (errorV1) {
					return cb(errorV1);
				}

				if (!(res.statusCode >= 200 && res.statusCode < 300)) {
					return cb(new Error(`Received ${res.statusCode} status code with body: ${resultString}`));
				}

				let resultObject;
				try {
					resultObject = parseResult(
						resultString,
						Object.assign({}, payment, { productId }),
						resultStringV2
					);
				} catch (e) {
					return cb(e);
				}

				return cb(null, resultObject);
			});
		}

		if (!payment.subscription) {
			return getV1(payment.productId);
		}

		const requestUrlV2 = apiUrls.purchasesSubscriptionsGetV2(
			payment.packageName,
			payment.receipt,
			token
		);
		const headers = {
			Authorization: `Bearer ${token}`
		};

		// The v2 endpoint is keyed on the purchase token alone, so it is fetched
		// first and used to resolve the product ID.
		return https.get(requestUrlV2, { headers }, function (errorV2, resV2, resultStringV2) {
			if (errorV2) {
				return cb(errorV2);
			}

			if (!(resV2.statusCode >= 200 && resV2.statusCode < 300)) {
				return cb(new Error(`Received ${resV2.statusCode} status code with body: ${resultStringV2}`));
			}

			let resultV2;
			try {
				resultV2 = JSON.parse(resultStringV2);
			} catch (e) {
				return cb(e);
			}

			// The v2 purchase is authoritative: a product ID supplied by the
			// caller can be stale after a plan change, and v1 resolves the
			// purchase from the token regardless of the ID it is given, so a
			// wrong one is silently recorded against the wrong product.
			const currentLineItem = resolveCurrentLineItem(resultV2.lineItems);
			const productId = currentLineItem ? currentLineItem.productId : payment.productId;

			if (!productId) {
				return cb(new Error(`No product ID found in subscription purchase v2 body: ${resultStringV2}`));
			}

			return getV1(productId, resultStringV2);
		});
	});
};


exports.cancelSubscription = function (payment, cb) {
	let keyObject;

	try {
		keyObject = validatePaymentAndParseKeyObject(payment);
	} catch (error) {
		return process.nextTick(function () {
			cb(error);
		});
	}

	jwt.getToken(keyObject.client_email, keyObject.private_key, apiUrls.publisherScope, function (error, token) {
		if (error) {
			return cb(error);
		}

		const requestUrl = apiUrls.purchasesSubscriptionsCancel(
			payment.packageName,
			payment.productId,
			payment.receipt,
			token
		);

		https.post(requestUrl, null, function (error, res, resultString) {
			if (error) {
				return cb(error);
			}

			if (res.statusCode !== 204) {
				return cb(new Error(`Received ${res.statusCode} status code with body: ${resultString}`));
			}

			return cb(null, null);
		});
	});
};


exports.deferSubscription = function (payment, deferralInfo, cb) {
	let keyObject;
	const options = {};

	try {
		keyObject = validatePaymentAndParseKeyObject(payment);
		options.json = {
			deferralInfo: validateDeferralInfo(deferralInfo)
		};
	} catch (error) {
		return process.nextTick(function () {
			cb(error);
		});
	}

	jwt.getToken(keyObject.client_email, keyObject.private_key, apiUrls.publisherScope, function (error, token) {
		if (error) {
			return cb(error);
		}

		const requestUrl = apiUrls.purchasesSubscriptionsDefer(
			payment.packageName,
			payment.productId,
			payment.receipt,
			token
		);

		https.post(requestUrl, options, function (error, res, resultString) {
			if (error) {
				return cb(error);
			}

			if (!(res.statusCode >= 200 && res.statusCode < 300)) {
				return cb(new Error(`Received ${res.statusCode} status code with body: ${resultString}`));
			}

			var resultObject;
			try {
				resultObject = JSON.parse(resultString);
			} catch (e) {
				return cb(e);
			}

			return cb(null, resultObject);
		});
	});
};

exports.acknowledgeSubscription = function (payment, cb) {
	let keyObject;
	const options = {};

	try {
		keyObject = validatePaymentAndParseKeyObject(payment);
	} catch (error) {
		return process.nextTick(function () {
			cb(error);
		});
	}

	jwt.getToken(keyObject.client_email, keyObject.private_key, apiUrls.publisherScope, function (error, token) {
		if (error) {
			return cb(error);
		}

		const requestUrl = apiUrls.purchasesSubscriptionsAcknowledge(
			payment.packageName,
			payment.productId,
			payment.receipt,
			token
		);

		https.post(requestUrl, options, function (error, res, resultString) {
			if (error) {
				return cb(error);
			}

			if (!(res.statusCode >= 200 && res.statusCode < 300)) {
				return cb(new Error(`Received ${res.statusCode} status code with body: ${resultString}`));
			}

			return cb(null, resultString);
		});
	});
};
