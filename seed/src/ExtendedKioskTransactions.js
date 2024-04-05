const { KioskTransaction, objArg, getNormalizedRuleType } = require('@mysten/kiosk');

class ExtendedKioskTransactions extends KioskTransaction {
	constructor({ transactionBlock, kioskClient, cap }, { adapter, market_type, market }) {
		super({ transactionBlock, kioskClient, cap });
		this.MARKETPLACE_ADAPTER = adapter;
		this.MARKET_TYPE = market_type;
		this.MARKET = market;
	}

	listOnMarket({ itemType, item, price }) {
		this.validateKioskIsSet();
		const txb = this.transactionBlock;
		txb.moveCall({
			target: `${this.MARKETPLACE_ADAPTER}::marketplace_trading_ext::list`,
			typeArguments: [itemType, this.MARKET_TYPE],
			arguments: [
				objArg(txb, this.kiosk),
				objArg(txb, this.kioskCap),
				txb.pure.address(item),
				txb.pure.u64(price),
			],
		});
		return this;
	}

	delistOnMarket({ itemType, item }) {
		this.validateKioskIsSet();

		const txb = this.transactionBlock;

		txb.moveCall({
			target: `${this.MARKETPLACE_ADAPTER}::marketplace_trading_ext::delist`,
			typeArguments: [itemType, this.MARKET_TYPE],
			arguments: [objArg(txb, this.kiosk), objArg(txb, this.kioskCap), txb.pure.address(item)],
		});
		return this;
	}

	purchaseOnMarket({ itemType, itemId, price, sellerKiosk }) {
		this.validateKioskIsSet();

		const txb = this.transactionBlock;

		const coin = this.transactionBlock.splitCoins(txb.gas, [txb.pure.u64(price)]);

		const [item, collectionTransferRequest, marketTransferRequest] = txb.moveCall({
			target: `${this.MARKETPLACE_ADAPTER}::marketplace_trading_ext::purchase`,
			typeArguments: [itemType, this.MARKET_TYPE],
			arguments: [objArg(txb, sellerKiosk), txb.pure(itemId), coin],
		});

		return [item, collectionTransferRequest, marketTransferRequest];
	}

	confirmRequest({ tx, itemType, policy, request }) {
		tx.moveCall({
			target: `0x2::transfer_policy::confirm_request`,
			typeArguments: [itemType],
			arguments: [objArg(tx, policy), request],
		});
	}

	checkPolicyRules({
		itemType,
		itemId,
		price,
		sellerKiosk,
		transferRequest,
		purchasedItem,
		policy,
		extraArgs,
	}) {
		let canTransferOutsideKiosk = true;

		for (const rule of policy.rules) {
			const ruleDefinition = this.kioskClient.rules.find(
				(x) => getNormalizedRuleType(x.rule) === getNormalizedRuleType(rule),
			);
			if (!ruleDefinition) {
				throw new Error(`No resolver for the following rule: ${rule}.`);
			}

			if (ruleDefinition.hasLockingRule) {
				canTransferOutsideKiosk = false;
			}

			ruleDefinition.resolveRuleFunction({
				packageId: ruleDefinition.packageId,
				transactionBlock: this.transactionBlock,
				itemType,
				itemId,
				price: price.toString(),
				sellerKiosk,
				policyId: policy.id,
				transferRequest,
				purchasedItem,
				kiosk: this.kiosk,
				kioskCap: this.kioskCap,
				extraArgs: extraArgs || {},
			});
		}

		this.confirmRequest({
			tx: this.transactionBlock,
			itemType: itemType,
			policy: policy.id,
			request: transferRequest,
		});

		return canTransferOutsideKiosk;
	}

	async purchaseAndResolveOnMarket({ itemType, itemId, price, sellerKiosk }) {
		const [purchasedItem, collectionTransferRequest, marketTransferRequest] = this.purchaseOnMarket(
			{
				itemType,
				itemId,
				price,
				sellerKiosk,
			},
		);

		const collectionPolicy = await this.getPolicy({ type: itemType });
		const marketPolicy = await this.getPolicy({ type: this.MARKET_TYPE });

		let canTransferOutsideKiosk = this.checkPolicyRules({
			itemType,
			itemId,
			price,
			sellerKiosk,
			transferRequest: collectionTransferRequest,
			purchasedItem,
			policy: collectionPolicy,
		});

		let canTransferOutsideKiosk2 = this.checkPolicyRules({
			itemType: this.MARKET_TYPE,
			itemId: this.MARKET,
			price,
			sellerKiosk,
			transferRequest: marketTransferRequest,
			purchasedItem,
			policy: marketPolicy,
		});

		if (canTransferOutsideKiosk && canTransferOutsideKiosk2) {
			this.place({
				itemType,
				item: purchasedItem,
			});
		}

		return this;
	}

	addTradingExtension() {
		this.validateKioskIsSet();
		const txb = this.transactionBlock;
		txb.moveCall({
			target: `${this.MARKETPLACE_ADAPTER}::marketplace_trading_ext::add`,
			arguments: [objArg(txb, this.kiosk), objArg(txb, this.kioskCap)],
		});
		return this;
	}

	addBiddingExtension() {
		this.validateKioskIsSet();
		const txb = this.transactionBlock;
		txb.moveCall({
			target: `${this.MARKETPLACE_ADAPTER}::collection_bidding_ext::add`,
			arguments: [objArg(txb, this.kiosk), objArg(txb, this.kioskCap)],
		});
		return this;
	}

	placeBidOnMarket({ type, price }) {
		this.validateKioskIsSet();
		const txb = this.transactionBlock;

		const coin = txb.splitCoins(txb.gas, [txb.pure.u64(price)]);

		const coins = txb.makeMoveVec({
			objects: [coin],
		});

		txb.moveCall({
			target: `${this.MARKETPLACE_ADAPTER}::collection_bidding_ext::place_bids`,
			typeArguments: [type, this.MARKET_TYPE],
			arguments: [objArg(txb, this.kiosk), objArg(txb, this.kioskCap), coins],
		});

		return this;
	}

	acceptBidOnMarket({ type, item, price, source }) {
		this.validateKioskIsSet();
		const txb = this.transactionBlock;

		const policy = getPolicy({ type: type });

		const mkt_cap = txb.moveCall({
			target: `${this.MARKETPLACE_ADAPTER}::marketplace_adapter::new`,
			typeArguments: [type, this.MARKET_TYPE],
			arguments: [
				objArg(txb, this.kiosk), //kiosk
				objArg(txb, this.kioskCap), //cap
				objArg(txb, item), //item
				txb.pure.u64(price), //min_price
			],
		});

		txb.moveCall({
			target: `${this.MARKETPLACE_ADAPTER}::collection_bidding_ext::accept_market_bid`,
			typeArguments: [type, this.MARKET_TYPE],
			arguments: [
				objArg(txb, this.kiosk), //dest kiosk
				objArg(txb, source), //source kiosk
				objArg(txb, mkt_cap), //mkt_cap
				objArg(txb, policy), //transfer_policy
				txb.pure.bool(false), //lock
			],
		});

		return this;
	}

	validateKioskIsSet() {
		if (!this.kiosk || !this.kioskCap) {
			throw new Error(
				'You need to initialize the client by either supplying an existing owner cap or by creating a new by calling `.create()`',
			);
		}
	}

	async getPolicy({ type }) {
		const policies = await this.kioskClient.getTransferPolicies({ type });

		if (policies.length === 0) {
			throw new Error(
				`The type ${type} doesn't have a Transfer Policy so it can't be traded through kiosk.`,
			);
		}

		return policies[0];
	}
}
