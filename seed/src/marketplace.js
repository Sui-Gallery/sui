// Copyright (c) Mysten Labs, Inc.
// SPDX-License-Identifier: Apache-2.0

const execSync = require('child_process').execSync;
const {
	FaucetRateLimitError,
	getFaucetHost,
	requestSuiFromFaucetV0,
} = require('@mysten/sui.js/faucet');
const { Ed25519Keypair } = require('@mysten/sui.js/keypairs/ed25519');
const { TransactionBlock } = require('@mysten/sui.js/transactions');
const tmp = require('tmp');
const { retry } = require('ts-retry-promise');
const { KioskClient, Network } = require('@mysten/kiosk');
const { getFullnodeUrl, SuiClient } = require('@mysten/sui.js/client');
const { ExtendedKioskTransactions } = require('./kiosk-transaction');
const dotenv = require('dotenv');
dotenv.config();

const client = new SuiClient({
	url: getFullnodeUrl('localnet'),
});

const kioskClient = new KioskClient({
	client,
	network: Network.CUSTOM,
});

const DEFAULT_FAUCET_URL = getFaucetHost('localnet');
const DEFAULT_FULLNODE_URL = getFullnodeUrl('localnet');
const SUI_BIN = 'cargo run --bin sui';

let MARKET = process.env.MARKET;
let MARKET_TYPE = process.env.MARKET_TYPE;
let MARKETPLACE_ADAPTER = process.env.MARKETPLACE_ADAPTER;

class TestToolbox {
	keypair;
	client;

	constructor(keypair, client) {
		this.keypair = keypair;
		this.client = client;
	}

	address() {
		return this.keypair.getPublicKey().toSuiAddress();
	}

	async getActiveValidators() {
		return (await this.client.getLatestSuiSystemState()).activeValidators;
	}
}

function getClient() {
	return new SuiClient({
		url: DEFAULT_FULLNODE_URL,
	});
}

async function setupSuiClient() {
	const keypair = Ed25519Keypair.generate();
	const address = keypair.getPublicKey().toSuiAddress();
	const client = getClient();
	await retry(() => requestSuiFromFaucetV0({ host: DEFAULT_FAUCET_URL, recipient: address }), {
		backoff: 'EXPONENTIAL',
		timeout: 1000 * 60,
		retryIf: (error) => !(error instanceof FaucetRateLimitError),
		logger: (msg) => console.warn('Retrying requesting from faucet: ' + msg),
	});
	return new TestToolbox(keypair, client);
}

async function publishPackage(packagePath, toolbox) {
	if (!toolbox) {
		toolbox = await setupSuiClient();
	}

	tmp.setGracefulCleanup();

	const tmpobj = tmp.dirSync({ unsafeCleanup: true });

	const { modules, dependencies } = JSON.parse(
		execSync(
			`${SUI_BIN} move build --dump-bytecode-as-base64 --path ${packagePath} --install-dir ${tmpobj.name}`,
			{ encoding: 'utf-8' },
		),
	);
	const txb = new TransactionBlock();
	const cap = txb.publish({
		modules,
		dependencies,
	});

	txb.transferObjects([cap], txb.pure(toolbox.address(), 'address'));

	const publishTxn = await toolbox.client.signAndExecuteTransactionBlock({
		transactionBlock: txb,
		signer: toolbox.keypair,
		options: {
			showEffects: true,
			showObjectChanges: true,
		},
	});

	if (publishTxn.effects.status.status !== 'success') {
		throw new Error('Unsuccessfull');
	}

	const packageId = (publishTxn.objectChanges?.filter((a) => a.type === 'published') ??
		[])[0].packageId.replace(/^(0x)(0+)/, '0x');

	console.info(`Published package ${packageId} from address ${toolbox.address()}}`);

	return { packageId, publishTxn };
}

async function executeTransactionBlock(toolbox, txb) {
	return await toolbox.client.signAndExecuteTransactionBlock({
		signer: toolbox.keypair,
		transactionBlock: txb,
		options: {
			showEffects: true,
			showEvents: true,
			showObjectChanges: true,
		},
	});
}

// eslint-disable-next-line @typescript-eslint/no-unused-vars
async function devInspectTransactionBlock(toolbox, txb) {
	return await toolbox.client.devInspectTransactionBlock({
		transactionBlock: txb,
		sender: toolbox.address(),
	});
}

async function withKioskTransaction({ address }, actionCallback) {
	const { cap } = await getKiosk({ address });

	const txb = new TransactionBlock();

	txb.setGasBudget(1000000000);

	const kioskTx = new ExtendedKioskTransactions(
		{
			transactionBlock: txb,
			kioskClient: kioskClient,
			cap: cap,
		},
		{
			adapter: MARKETPLACE_ADAPTER,
			market_type: MARKET_TYPE,
			market: MARKET,
		},
	);

	if (!cap) {
		kioskTx.create();
	}

	await actionCallback(txb, kioskTx, cap);

	if (!cap) {
		kioskTx.shareAndTransferCap(address);
	}

	kioskTx.finalize();

	return txb;
}

async function getKiosk({ address, kioskId }) {
	if (address) {
		const { kioskOwnerCaps, kioskIds } = await kioskClient.getOwnedKiosks({ address });
		const cap = kioskOwnerCaps[kioskIds.length - 1];

		return {
			cap,
		};
	} else if (kioskId) {
		return kioskClient.getKiosk({
			id: kioskId,
			options: {
				withKioskFields: true,
			},
		});
	}
}

async function placeAndListOnMarket({ address, item, type, price }) {
	return await withKioskTransaction({ address }, async (txb, kioskTx, cap) => {
		kioskTx
			.place({
				item,
				itemType: type,
			})
			.listOnMarket({
				itemType: type,
				item,
				price,
			});
	});
}

async function delistOnMarket({ address, item, type }) {
	return await withKioskTransaction({ address }, async (txb, kioskTx, cap) => {
		kioskTx.delistOnMarket({
			itemType: type,
			item,
		});
	});
}

async function listOnMarket({ address, item, type, price }) {
	return await withKioskTransaction({ address }, async (txb, kioskTx, cap) => {
		kioskTx.listOnMarket({
			itemType: type,
			item,
			price,
		});
	});
}

async function delistAndListOnMarket({ address, item, type, price }) {
	return await withKioskTransaction({ address }, async (txb, kioskTx, cap) => {
		kioskTx
			.delistOnMarket({
				itemType: type,
				item,
				price,
			})
			.listOnMarket({
				itemType: type,
				item,
				price,
			});
	});
}

async function bidOnMarket({ address, type, price }) {
	return await withKioskTransaction({ address }, async (txb, kioskTx, cap) => {
		kioskTx.placeBidOnMarket({
			type: type,
			price,
		});
	});
}

async function revokeBidOnMarket({ address, type, price, count }) {
	return await withKioskTransaction({ address }, async (txb, kioskTx, cap) => {
		kioskTx.revokeBidOnMarket({
			type: type,
			price: price,
			count: count,
			address: address,
		});
	});
}

async function acceptBidOnMarket({ address, type, price, item, buyer }) {
	return await withKioskTransaction({ address }, async (txb, kioskTx, cap) => {
		const owner = await getOwner({
			item: item,
		});

		if (!owner.isKiosk) {
			kioskTx.place({
				itemType: type,
				item: item,
			});
		}

		await kioskTx.acceptBidOnMarket({
			type: type,
			item: item,
			price: price,
			buyer: buyer,
		});
	});
}

async function addTradingExtension(address) {
	return await withKioskTransaction({ address }, async (txb, kioskTx, cap) => {
		kioskTx.addTradingExtension({ address });
	});
}

async function addBiddingExtension(address) {
	return await withKioskTransaction({ address }, async (txb, kioskTx, cap) => {
		kioskTx.addBiddingExtension({ address });
	});
}

async function getOwner({ item }) {
	const res = await client.getObject({
		id: item,
		options: {
			showOwner: true,
			showType: true,
		},
	});

	if (res.data.owner.AddressOwner) {
		return {
			isKiosk: false,
			owner: res.data.owner.AddressOwner,
		};
	} else if (res.data.owner.ObjectOwner) {
		const res2 = await client.getObject({
			id: res.data.owner.ObjectOwner,
			options: {
				showOwner: true,
				showType: true,
			},
		});

		if (!res2.data.type.includes('0x2::dynamic_field::Field')) {
			throw new Error('Edge case');
		}

		const res3 = await client.getObject({
			id: res2.data.owner.ObjectOwner,
			options: {
				showOwner: true,
				showType: true,
			},
		});

		if (res3.data.type.includes('0x2::kiosk::Kiosk')) {
			return {
				isKiosk: true,
				owner: res3.data.objectId,
			};
		}

		return null;
	}
}

async function executeList({ address, item, type, price, toolbox }) {
	const owner = await getOwner({
		item: item,
	});
	let txb;
	if (!owner.isKiosk) {
		txb = await placeAndListOnMarket({ address, item, type, price });
	} else {
		txb = await listOnMarket({ address, item, type, price });
	}

	return await executeTransactionBlock(toolbox, txb)
		.then((r) => {
			const kiosk = r.objectChanges.find((x) => x.objectType === '0x2::kiosk::Kiosk');
			console.log(`List is ${r.effects.status.status}`);
			return kiosk.objectId;
		})
		.catch((e) => {
			console.log('Error while listing');
			console.log(e);
		});
}

async function executeDelist({ address, item, type, price, toolbox }) {
	const txb = await delistOnMarket({ address, item, type, price });

	await executeTransactionBlock(toolbox, txb)
		.then((r) => {
			console.log(`Delist is ${r.effects.status.status}`);
		})
		.catch((e) => {
			console.log(e);
		});
}

async function executeBuy({ sellerKiosk, address, item, type, price, toolbox }) {
	const txb = await purchaseAndResolveOnMarket({ address, sellerKiosk, item, type, price });
	await executeTransactionBlock(toolbox, txb)
		.then((r) => {
			console.log(`Buy is ${r.effects.status.status}`);
		})
		.catch((e) => {
			console.log(e);
		});
}

async function executeDelistAndList({ sellerKiosk, address, item, type, price, toolbox }) {
	const txb = await delistAndListOnMarket({ address, item, type, price });

	await executeTransactionBlock(toolbox, txb)
		.then((r) => {
			console.log(`Delist is ${r.effects.status.status}`);
		})
		.catch((e) => {
			console.log(e);
		});
}

async function executeAddExtension({ toolbox }) {
	const txb = await addTradingExtension(toolbox.address());

	await executeTransactionBlock(toolbox, txb)
		.then((r) => {
			console.log(`Add Trading Extension is ${r.effects.status.status}`);
		})
		.catch((e) => {
			console.log(e);
		});

	const txb2 = await addBiddingExtension(toolbox.address());

	return await executeTransactionBlock(toolbox, txb2)
		.then((r) => {
			console.log(`Add Bidding Extension is ${r.effects.status.status}`);
			const a = r.objectChanges.find((x) => x.objectType === '0x2::kiosk::Kiosk');
			return a.objectId;
		})
		.catch((e) => {
			console.log(e);
		});
}

async function executePlaceBid({ toolbox, address, type, price }) {
	const txb = await bidOnMarket({ address, type, price });
	await executeTransactionBlock(toolbox, txb)
		.then((r) => {
			console.log(r)
			console.log(`Place bid is ${r.effects.status.status}`);
		})
		.catch((e) => {
			console.log(e);
		});
}

async function executeAcceptBid({ toolbox, address, buyer, type, price, item }) {
	const txb = await acceptBidOnMarket({ address, buyer: buyer, type, price, item });

	await executeTransactionBlock(toolbox, txb)
		.then((r) => {
			console.log(`Accept bid is ${r.effects.status.status}`);
		})
		.catch((e) => {
			console.log(e);
		});
}

async function executeRevokeBid({ toolbox, address, type, price, count }) {
	const txb = await revokeBidOnMarket({ address, type, price, count });

	await executeTransactionBlock(toolbox, txb)
		.then((r) => {
			console.log(`Revoke bid is ${r.effects.status.status}`);
		})
		.catch((e) => {
			console.log(e);
		});
}

async function purchaseAndResolveOnMarket({ address, sellerKiosk, item, type, price }) {
	return await withKioskTransaction({ address }, async (txb, kioskTx, cap) => {
		await kioskTx.purchaseAndResolveOnMarket({
			itemType: type,
			itemId: item,
			price: price,
			sellerKiosk: sellerKiosk,
		});
	});
}

async function executeMint({ toolbox }) {
	const txb = new TransactionBlock();

	txb.moveCall({
		target: `${MARKET}::devnet_nft::mint`,
		arguments: [txb.pure('NFT'), txb.pure('NFT'), txb.pure('sui.gallery')],
	});

	return await executeTransactionBlock(toolbox, txb)
		.then((r) => {
			console.log(`Mint is ${r.effects.status.status}`);
			const nft = r.objectChanges.find((x) => x.objectType.includes('DevNetNFT'));
			return nft.objectId;
		})
		.catch((e) => {
			console.log(e);
		});
}

// eslint-disable-next-line @typescript-eslint/no-unused-vars
async function run_scenario_1() {
	console.log('Running Scenario 1');
	const toolbox = await setupSuiClient();
	await executeAddExtension({ toolbox });
	const nftId = await executeMint({ toolbox });
	let price = Math.max(parseInt(1e10 * Math.random()), 1e8);
	let kioskId = await executeList({
		toolbox,
		address: toolbox.address(),
		item: nftId,
		type: `${MARKET}::devnet_nft::DevNetNFT`,
		price: price,
	});

	// const bidToolbox = await setupSuiClient();
	// await executeAddExtension({ toolbox: bidToolbox });
	//
	// await executePlaceBid({
	// 	toolbox: bidToolbox,
	// 	address: bidToolbox.address(),
	// 	type: `${MARKET}::devnet_nft::DevNetNFT`,
	// 	price: Math.max(parseInt(1e10 * Math.random()), 1e8),
	// });

	const toolbox2 = await setupSuiClient();
	await executeAddExtension({ toolbox: toolbox2 });

	await executeBuy({
		toolbox: toolbox2,
		sellerKiosk: kioskId,
		address: toolbox2.address(),
		item: nftId,
		type: `${MARKET}::devnet_nft::DevNetNFT`,
		price: price,
	});
	console.log('------------------------------');
}

// eslint-disable-next-line @typescript-eslint/no-unused-vars
async function run_scenario_2() {
	console.log('Running Scenario 2');
	const toolbox = await setupSuiClient();
	await executeAddExtension({ toolbox });
	const nftId = await executeMint({ toolbox });
	let price = Math.max(parseInt(1e10 * Math.random()), 1e8);
	await executeList({
		toolbox,
		address: toolbox.address(),
		item: nftId,
		type: `${MARKET}::devnet_nft::DevNetNFT`,
		price: price,
	});

	// await executeDelistAndList({
	// 	toolbox,
	// 	address: toolbox.address(),
	// 	item: nftId,
	// 	type: `${MARKET}::devnet_nft::DevNetNFT`,
	// 	price: price,
	// });
	console.log('------------------------------');
}

/*
    Bid and accept bid on unlisted item
*/
async function run_scenario_3() {
	console.log('Running Scenario 2');
	const sellerToolbox = await setupSuiClient();
	await executeAddExtension({ toolbox: sellerToolbox });
	const nftId = await executeMint({ toolbox: sellerToolbox });

	const buyerToolbox = await setupSuiClient();
	const buyerKiosk = await executeAddExtension({ toolbox: buyerToolbox });
	const bidPrice = Math.max(parseInt(1e10 * Math.random()), 1e8);

	await executePlaceBid({
		toolbox: buyerToolbox,
		address: buyerToolbox.address(),
		type: `${MARKET}::devnet_nft::DevNetNFT`,
		price: bidPrice,
	});

	await executeAcceptBid({
		toolbox: sellerToolbox,
		address: sellerToolbox.address(),
		type: `${MARKET}::devnet_nft::DevNetNFT`,
		buyer: buyerKiosk,
		price: bidPrice,
		item: nftId,
	});
}

async function run_scenario_4() {
	console.log('Running Scenario 4');
	const buyerToolbox = await setupSuiClient();
	await executeAddExtension({ toolbox: buyerToolbox });
	const bidPrice = Math.max(parseInt(1e10 * Math.random()), 1e8);

	await executePlaceBid({
		toolbox: buyerToolbox,
		address: buyerToolbox.address(),
		type: `${MARKET}::devnet_nft::DevNetNFT`,
		price: bidPrice,
	});

	await executePlaceBid({
		toolbox: buyerToolbox,
		address: buyerToolbox.address(),
		type: `${MARKET}::devnet_nft::DevNetNFT`,
		price: bidPrice,
	});

	await executePlaceBid({
		toolbox: buyerToolbox,
		address: buyerToolbox.address(),
		type: `${MARKET}::devnet_nft::DevNetNFT`,
		price: bidPrice,
	});

	await executeRevokeBid({
		toolbox: buyerToolbox,
		address: buyerToolbox.address(),
		type: `${MARKET}::devnet_nft::DevNetNFT`,
		price: bidPrice,
		count: 2,
	});
}

async function repeat() {
	while (true) {
		// await run_scenario_1();
		// await run_scenario_2();
		// await run_scenario_3();
		await run_scenario_4();
	}
}

async function main() {
	if (!MARKET_TYPE || !MARKET) {
		await publishPackage('../sui-gallery-marketplace')
			.then(async (r) => {
				console.log(`
            MARKET_TYPE: ${r.packageId}::marketplace::Gallery`);
				MARKET_TYPE = `${r.packageId}::marketplace::Gallery`;
				MARKET = r.packageId;
			})
			.catch((e) => {
				console.log(e);
			});
	}
	if (!MARKETPLACE_ADAPTER) {
		await publishPackage('../kiosk')
			.then(async (r) => {
				console.log(`
            MARKETPLACE_ADAPTER: ${r.packageId}`);
				MARKETPLACE_ADAPTER = r.packageId;
			})
			.catch((e) => {
				console.log(e);
			});
	}

	repeat();
}

main();
