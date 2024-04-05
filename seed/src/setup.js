// Copyright (c) Mysten Labs, Inc.
// SPDX-License-Identifier: Apache-2.0

const execSync = require('child_process').execSync;
const { getFullnodeUrl, SuiClient } = require('@mysten/sui.js/client');
const {
	FaucetRateLimitError,
	getFaucetHost,
	requestSuiFromFaucetV0,
} = require('@mysten/sui.js/faucet');
const { Ed25519Keypair } = require('@mysten/sui.js/keypairs/ed25519');
const { TransactionBlock } = require('@mysten/sui.js/transactions');
const tmp = require('tmp');
const { retry } = require('ts-retry-promise');

const DEFAULT_FAUCET_URL = getFaucetHost('localnet');
const DEFAULT_FULLNODE_URL = getFullnodeUrl('localnet');
const SUI_BIN = 'cargo run --bin sui';

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

let packageID = '0x34ca1463c62c377ba27524a774a5257f8523779999e9139c11563508b52a4a46';

function getClient() {
	return new SuiClient({
		url: DEFAULT_FULLNODE_URL,
	});
}

// TODO: expose these testing utils from @mysten/sui.js
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
	packageID = packageId;
	return { packageId, publishTxn };
}

// eslint-disable-next-line @typescript-eslint/no-unused-vars
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

async function executeTransactionEverySecond(toolbox) {
	setInterval(async () => {
		toolbox = await setupSuiClient();

		let txb = new TransactionBlock();
		const [coin] = txb.splitCoins(txb.gas, [txb.pure(1000)]);
		txb.moveCall({
			target: `${packageID}::game::create_game`,
			arguments: [txb.pure('name'), txb.pure(new Date().getTime()), coin],
			typeArguments: ['0x2::sui::SUI'],
		});
		await executeTransactionBlock(toolbox, txb)
			.then((r) => {
				console.log(r.effects.status.status);
			})
			.catch((e) => {
				console.log(e);
			});
	}, 3000);
}

publishPackage('/Users/volthai7us/Desktop/dev/sui-gallery/sui-place/sui_place')
	.then(async (r) => {
		executeTransactionEverySecond()
	})
	.catch((e) => {
		console.log(e);
	});

// executeTransactionEverySecond()
// 	.then((r) => {
// 		console.log(r);
// 	})
// 	.catch((e) => {
// 		console.log(e);
// 	});
