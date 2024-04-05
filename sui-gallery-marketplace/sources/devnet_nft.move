// Copyright (c) Mysten Labs, Inc.
// SPDX-License-Identifier: Apache-2.0

// TODO: consider renaming this to `example_nft`
/// A minimalist example to demonstrate how to create an NFT like object
/// on Sui.
module gallery::devnet_nft {
    use sui::url::{Self, Url};
    use std::string;
    use sui::object::{Self, ID, UID};
    use sui::event;
    use sui::transfer_policy as policy;
    use sui::transfer;
    use sui::tx_context::{Self, sender, TxContext};

    struct DEVNET_NFT has drop {}

    /// An example NFT that can be minted by anybody
    struct DevNetNFT has key, store {
        id: UID,
        /// Name for the token
        name: string::String,
        /// Description of the token
        description: string::String,
        /// URL for the token
        url: Url,
        image_url: Url,
    }

    struct MintNFTEvent has copy, drop {
        // The Object ID of the NFT
        object_id: ID,
        // The creator of the NFT
        creator: address,
        // The name of the NFT
        name: string::String,
        // The image of the NFT
        image_url: Url
    }

    fun init(otw: DEVNET_NFT, ctx: &mut TxContext) {
        let publisher = sui::package::claim(otw, ctx);
        let (policy, policy_cap) = policy::new<DevNetNFT>(&publisher, ctx);

        transfer::public_share_object(policy);
        transfer::public_transfer(policy_cap, sender(ctx));
        transfer::public_transfer(publisher, sender(ctx));
    }

    /// Create a new devnet_nft
    public entry fun mint(
        name: vector<u8>,
        description: vector<u8>,
        url: vector<u8>,
        ctx: &mut TxContext
    ) {
        let nft = DevNetNFT {
            id: object::new(ctx),
            name: string::utf8(name),
            description: string::utf8(description),
            url: url::new_unsafe_from_bytes(url),
            image_url: url::new_unsafe_from_bytes(b"https://pbs.twimg.com/profile_images/1652004909091356672/B5S6JzVn_400x400.jpg")
        };
        let sender = tx_context::sender(ctx);
        event::emit(MintNFTEvent {
            object_id: object::uid_to_inner(&nft.id),
            creator: sender,
            name: nft.name,
            image_url: url::new_unsafe_from_bytes(b"https://pbs.twimg.com/profile_images/1652004909091356672/B5S6JzVn_400x400.jpg")
        });
        transfer::public_transfer(nft, sender);
    }

    /// Update the `description` of `nft` to `new_description`
    public entry fun update_description(
        nft: &mut DevNetNFT,
        new_description: vector<u8>,
    ) {
        nft.description = string::utf8(new_description)
    }

    /// Permanently delete `nft`
    public entry fun burn(nft: DevNetNFT) {
        let DevNetNFT { id, name: _, description: _, url: _, image_url: _ } = nft;
        object::delete(id)
    }

    /// Get the NFT's `name`
    public fun name(nft: &DevNetNFT): &string::String {
        &nft.name
    }

    /// Get the NFT's `description`
    public fun description(nft: &DevNetNFT): &string::String {
        &nft.description
    }

    /// Get the NFT's `url`
    public fun url(nft: &DevNetNFT): &Url {
        &nft.url
    }
}