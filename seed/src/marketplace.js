// Copyright (c) Mysten Labs, Inc.
// SPDX-License-Identifier: Apache-2.0

const execSync = require('child_process').execSync
const {
    FaucetRateLimitError,
    getFaucetHost,
    requestSuiFromFaucetV0,
} = require('@mysten/sui.js/faucet')
const { Ed25519Keypair } = require('@mysten/sui.js/keypairs/ed25519')
const { TransactionBlock } = require('@mysten/sui.js/transactions')
const tmp = require('tmp')
const { retry } = require('ts-retry-promise')
const {
    KioskClient, Network,
} = require('@mysten/kiosk')
const { getFullnodeUrl, SuiClient } = require('@mysten/sui.js/client')
const { ExtendedKioskTransactions } = require('./kiosk-transaction')

const client = new SuiClient({
    url: getFullnodeUrl('localnet'),
})

const kioskClient = new KioskClient({
    client, network: Network.CUSTOM,
})

const DEFAULT_FAUCET_URL = getFaucetHost('localnet')
const DEFAULT_FULLNODE_URL = getFullnodeUrl('localnet')
const SUI_BIN = 'cargo run --bin sui'

let MARKET = '0x678f7d35495132335e294087f64cc83821c78975568498b268a1ff14aa3ea8c0'
let MARKET_TYPE = '0x678f7d35495132335e294087f64cc83821c78975568498b268a1ff14aa3ea8c0::marketplace::Gallery'
let MARKETPLACE_ADAPTER = '0x75d5d0ce376de818cbe0a837f0214fff0f89c77b964b64835b66fa6bcb8806be'

class TestToolbox {
    keypair
    client

    constructor(keypair, client) {
        this.keypair = keypair
        this.client = client
    }

    address() {
        return this.keypair.getPublicKey().toSuiAddress()
    }

    async getActiveValidators() {
        return (await this.client.getLatestSuiSystemState()).activeValidators
    }
}

function getClient() {
    return new SuiClient({
        url: DEFAULT_FULLNODE_URL,
    })
}

// TODO: expose these testing utils from @mysten/sui.js
async function setupSuiClient() {
    const keypair = Ed25519Keypair.generate()
    const address = keypair.getPublicKey().toSuiAddress()
    const client = getClient()
    await retry(() => requestSuiFromFaucetV0({ host: DEFAULT_FAUCET_URL, recipient: address }), {
        backoff: 'EXPONENTIAL',
        timeout: 1000 * 60,
        retryIf: (error) => !(error instanceof FaucetRateLimitError),
        logger: (msg) => console.warn('Retrying requesting from faucet: ' + msg),
    })
    return new TestToolbox(keypair, client)
}

async function publishPackage(packagePath, toolbox) {
    if (!toolbox) {
        toolbox = await setupSuiClient()
    }

    tmp.setGracefulCleanup()

    const tmpobj = tmp.dirSync({ unsafeCleanup: true })

    const { modules, dependencies } = JSON.parse(
        execSync(
            `${SUI_BIN} move build --dump-bytecode-as-base64 --path ${packagePath} --install-dir ${tmpobj.name}`,
            { encoding: 'utf-8' },
        ),
    )
    const txb = new TransactionBlock()
    const cap = txb.publish({
        modules,
        dependencies,
    })

    txb.transferObjects([cap], txb.pure(toolbox.address(), 'address'))

    const publishTxn = await toolbox.client.signAndExecuteTransactionBlock({
        transactionBlock: txb,
        signer: toolbox.keypair,
        options: {
            showEffects: true,
            showObjectChanges: true,
        },
    })

    if (publishTxn.effects.status.status !== 'success') {
        throw new Error('Unsuccessfull')
    }

    const packageId = (publishTxn.objectChanges?.filter((a) => a.type === 'published') ??
        [])[0].packageId.replace(/^(0x)(0+)/, '0x')

    console.info(`Published package ${packageId} from address ${toolbox.address()}}`)
    packageID = packageId
    return { packageId, publishTxn }
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
    })
}

// eslint-disable-next-line @typescript-eslint/no-unused-vars
async function devInspectTransactionBlock(toolbox, txb) {
    return await toolbox.client.devInspectTransactionBlock({
        transactionBlock: txb,
        sender: toolbox.address(),
    })
}

async function withKioskTransaction({ address }, actionCallback) {
    const { cap } = await getKiosk({ address })

    const txb = new TransactionBlock()

    // txb.setGasBudget(1000000000)

    const kioskTx = new ExtendedKioskTransactions({
            transactionBlock: txb,
            kioskClient: kioskClient,
            cap: cap,
        }, {
            adapter: MARKETPLACE_ADAPTER,
            market_type: MARKET_TYPE,
            market: MARKET,
        },
    )

    if (!cap) {
        kioskTx.create()
    }

    await actionCallback(txb, kioskTx, cap)

    if (!cap) {
        kioskTx.shareAndTransferCap(address)
    }

    kioskTx.finalize()

    return txb
}

async function getKiosk({ address, kioskId }) {
    if (address) {
        const { kioskOwnerCaps, kioskIds } = await kioskClient.getOwnedKiosks({ address })
        const cap = kioskOwnerCaps[0]

        return {
            cap,
        }
    } else if (kioskId) {
        return kioskClient.getKiosk(
            {
                id: kioskId,
                options: {
                    withKioskFields: true,
                },
            },
        )
    }
}

async function placeAndListOnMarket({ address, item, type, price }) {
    return await withKioskTransaction({ address }, async (txb, kioskTx, cap) => {
        kioskTx
            .place({
                item, itemType: type,
            })
            .listOnMarket({
                itemType: type, item, price,
            })
    })
}


async function delistOnMarket({ address, item, type }) {
    return await withKioskTransaction({ address }, async (txb, kioskTx, cap) => {
        kioskTx.delistOnMarket({
            itemType: type, item,
        })
    })
}

async function listOnMarket({ address, item, type, price }) {
    return await withKioskTransaction({ address }, async (txb, kioskTx, cap) => {
        kioskTx.listOnMarket({
            itemType: type, item, price,
        })
    })
}

async function addTradingExtension(address) {
    return await withKioskTransaction({ address }, async (txb, kioskTx, cap) => {
        kioskTx.addTradingExtension({ address })
    })
}

async function addBiddingExtension(address) {
    return await withKioskTransaction({ address }, async (txb, kioskTx, cap) => {
        kioskTx.addBiddingExtension({ address })
    })
}

async function getOwner({
                            item,
                        }) {
    const res = await client.getObject({
        id: item,
        options: {
            showOwner: true,
            showType: true,
        },
    })

    if (res.data.owner.AddressOwner) {
        return {
            isKiosk: false,
            owner: res.data.owner.AddressOwner,
        }
    } else if (res.data.owner.ObjectOwner) {
        const res2 = await client.getObject({
            id: res.data.owner.ObjectOwner,
            options: {
                showOwner: true,
                showType: true,
            },
        })

        if (!res2.data.type.includes('0x2::dynamic_field::Field')) {
            throw new Error('Edge case')
        }

        const res3 = await client.getObject({
            id: res2.data.owner.ObjectOwner,
            options: {
                showOwner: true,
                showType: true,
            },
        })

        if (res3.data.type.includes('0x2::kiosk::Kiosk')) {
            return {
                isKiosk: true,
                owner: res3.data.objectId,
            }
        }

        return null
    }
}

async function executeList({
                               address, item, type, price, toolbox,
                           }) {
    const owner = await getOwner({
        item: item,
    })
    let txb
    if (!owner.isKiosk) {
        txb = await placeAndListOnMarket({ address, item, type, price })
    } else {
        txb = await listOnMarket({ address, item, type, price })
    }

    return await executeTransactionBlock(toolbox, txb)
        .then((r) => {
            const kiosk = r.objectChanges.find(x => x.objectType === '0x2::kiosk::Kiosk')
            console.log(`List is ${r.effects.status.status}`)
            return kiosk.objectId
        })
        .catch((e) => {
            console.log('Error while listing')
            console.log(e)
        })
}

async function executeDelist({
                                 address, item, type, price, toolbox,
                             }) {
    const txb = await delistOnMarket({ address, item, type, price })

    await executeTransactionBlock(toolbox, txb)
        .then((r) => {
            console.log(`Delist is ${r.effects.status.status}`)
        })
        .catch((e) => {
            console.log(e)
        })
}

async function executeBuy({
                              sellerKiosk, address, item, type, price, toolbox,
                          }) {
    // const owner = client.getObject({
    //     id: item,
    //     options: {
    //         showOwner: true,
    //     },
    // })
    //
    // console.log(owner)
    // return
    const txb = await purchaseAndResolveOnMarket({ address, sellerKiosk, item, type, price })
    await executeTransactionBlock(toolbox, txb)
        .then((r) => {
            console.log(`Buy is ${r.effects.status.status}`)
        })
        .catch((e) => {
            console.log(e)
        })
}

async function executeAddExtension({ toolbox }) {
    const txb = await addTradingExtension(toolbox.address())

    await executeTransactionBlock(toolbox, txb)
        .then((r) => {
            console.log(`Add Extension is ${r.effects.status.status}`)
        })
        .catch((e) => {
            console.log(e)
        })
}

async function purchaseAndResolveOnMarket({ address, sellerKiosk, item, type, price }) {
    return await withKioskTransaction({ address }, async (txb, kioskTx, cap) => {
        await kioskTx.purchaseAndResolveOnMarket({
            itemType: type,
            itemId: item,
            price: price,
            sellerKiosk: sellerKiosk,
        })
    })
}

async function executeMint({ toolbox }) {
    const txb = new TransactionBlock()

    txb.moveCall({
        target: `${MARKET}::devnet_nft::mint`,
        arguments: [txb.pure('NFT'), txb.pure('NFT'), txb.pure('sui.gallery')],
    })

    return await executeTransactionBlock(toolbox, txb)
        .then((r) => {
            console.log(`Mint is ${r.effects.status.status}`)
            const nft = r.objectChanges.find(x => x.objectType.includes('DevNetNFT'))
            return nft.objectId
        })
        .catch((e) => {
            console.log(e)
        })
}

async function run_scenario_1() {
    console.log("Running Scenario 1")
    const toolbox = await setupSuiClient()
    await executeAddExtension({ toolbox })
    const nftId = await executeMint({ toolbox })
    let kioskId = await executeList({
        toolbox,
        address: toolbox.address(),
        item: nftId,
        type: `${MARKET}::devnet_nft::DevNetNFT`,
        price: 1000,
    })
    await executeBuy({
        toolbox,
        sellerKiosk: kioskId,
        address: toolbox.address(),
        item: nftId,
        type: `${MARKET}::devnet_nft::DevNetNFT`,
        price: 1000,
    })
    console.log("------------------------------")
}

async function run_scenario_2() {
    console.log("Running Scenario 2")
    const toolbox = await setupSuiClient()
    await executeAddExtension({ toolbox })
    const nftId = await executeMint({ toolbox })
    let kioskId = await executeList({
        toolbox,
        address: toolbox.address(),
        item: nftId,
        type: `${MARKET}::devnet_nft::DevNetNFT`,
        price: 1000,
    })
    await executeDelist({
        toolbox,
        address: toolbox.address(),
        item: nftId,
        type: `${MARKET}::devnet_nft::DevNetNFT`,
    })
    kioskId = await executeList({
        toolbox,
        address: toolbox.address(),
        item: nftId,
        type: `${MARKET}::devnet_nft::DevNetNFT`,
        price: 1000,
    })
    console.log("------------------------------")
}

async function repeat() {
    // setInterval(async () => {

    const toolbox = await setupSuiClient()
    await executeAddExtension({ toolbox })
    const nftId = await executeMint({ toolbox })
    let kioskId = await executeList({
        toolbox,
        address: toolbox.address(),
        item: nftId,
        type: `${MARKET}::devnet_nft::DevNetNFT`,
        price: 1000,
    })
    // await executeDelist({
    //     toolbox,
    //     address: toolbox.address(),
    //     item: nftId,
    //     type: `${MARKET}::devnet_nft::DevNetNFT`,
    // })
    // kioskId = await executeList({
    //     toolbox,
    //     address: toolbox.address(),
    //     item: nftId,
    //     type: `${MARKET}::devnet_nft::DevNetNFT`,
    //     price: 1000,
    // })
    await executeBuy({
        toolbox,
        sellerKiosk: kioskId,
        address: toolbox.address(),
        item: nftId,
        type: `${MARKET}::devnet_nft::DevNetNFT`,
        price: 1000,
    })
    // }, 2000)
}

async function main() {
    if (!MARKET_TYPE || !MARKET) {
        publishPackage('../sui-gallery-marketplace')
            .then(async (r) => {
                console.log(`
            MARKET_TYPE: ${r.packageId}::marketplace::Gallery`)
                MARKET_TYPE = `${r.packageId}::marketplace::Gallery`
                MARKET = r.packageId
            })
            .catch((e) => {
                console.log(e)
            })
    }
    if (!MARKETPLACE_ADAPTER) {
        publishPackage('../kiosk')
            .then(async (r) => {
                console.log(`
            MARKETPLACE_ADAPTER: ${r.packageId}`)
                MARKETPLACE_ADAPTER = r.packageId
            })
            .catch((e) => {
                console.log(e)
            })
    }

    await run_scenario_1()
    await run_scenario_2()
}

main()