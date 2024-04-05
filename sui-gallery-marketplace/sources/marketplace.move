// Copyright (c) Mysten Labs, Inc.
// SPDX-License-Identifier: Apache-2.0

/// An example of a Marketplace. In Kiosk terms, a Marketplace is an entity similar
/// to Creator - it owns and manages a `TransferPolicy` special to the marketplace
/// and when a marketplace deal happens (eg via the `marketplace_adapter`), the
/// marketplace enforces its own rules on the deal.
///
/// For reference, see the `marketplace_adapter` module.
module gallery::marketplace {
    use sui::tx_context::{sender, TxContext};
    use sui::transfer_policy as policy;
    use sui::transfer;

    /// The One-Time-Witness for the module.
    struct MARKETPLACE has drop {}

    /// A type identifying the Marketplace.
    struct Gallery has drop {}

    /// As easy as creating a Publisher; for simplicity's sake we also create
    /// the `MARKETPLACE` but this action can be performed offline in a PTB.
    #[lint_allow(self_transfer)]
    fun init(otw: MARKETPLACE, ctx: &mut TxContext) {
        let publisher = sui::package::claim(otw, ctx);
        let (policy, policy_cap) = policy::new<Gallery>(&publisher, ctx);

        transfer::public_share_object(policy);
        transfer::public_transfer(policy_cap, sender(ctx));
        transfer::public_transfer(publisher, sender(ctx));
    }
}
