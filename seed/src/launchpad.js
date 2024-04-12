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
const { getFullnodeUrl, SuiClient } = require('@mysten/sui.js/client');
const dotenv = require('dotenv');
dotenv.config();

const NETWORK = process.env.NETWORK || 'localnet';

const client = new SuiClient({
	url: getFullnodeUrl(NETWORK),
});

const DEFAULT_FAUCET_URL = getFaucetHost(NETWORK);
const DEFAULT_FULLNODE_URL = getFullnodeUrl(NETWORK);
const SUI_BIN = 'cargo run --bin sui';

let LAUNCHPAD = process.env.LAUNCHPAD;

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

async function executeMint({ toolbox }) {
	const txb = new TransactionBlock();

	txb.moveCall({
		target: `${LAUNCHPAD}::launch::mint`,
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


async function run_scenario_1() {
	const toolbox = await setupSuiClient();
	const nftId = await executeMint({ toolbox });
	console.log('------------------------------');
}

async function repeat() {
	while (true) {
		await run_scenario_1();
	}
}

async function main() {
	if (!LAUNCHPAD) {
		await publishPackage('/Users/volthai7us/Desktop/dev/sui-gallery/sui-gallery-contract/launchpad')
			.then(async (r) => {
				console.log(`LAUNCHPAD: ${r.packageId}`);
				LAUNCHPAD = r.packageId;
			})
			.catch((e) => {
				console.log(e);
			});
	}

	// repeat();
}

main();
