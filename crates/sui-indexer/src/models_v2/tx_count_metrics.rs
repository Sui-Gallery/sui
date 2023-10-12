// Copyright (c) Mysten Labs, Inc.
// SPDX-License-Identifier: Apache-2.0

use diesel::prelude::*;

use crate::schema_v2::tx_count_metrics;

use super::checkpoints::StoredCheckpoint;
use super::transactions::StoredTransaction;

#[derive(Clone, Debug, Default, Queryable, Insertable)]
#[diesel(table_name = tx_count_metrics)]
pub struct StoredTxCountMetrics {
    pub checkpoint_sequence_number: i64,
    pub epoch: i64,
    pub timestamp_ms: i64,
    pub total_transaction_blocks: i64,
    pub total_successful_transaction_blocks: i64,
    pub total_successful_transactions: i64,
    pub network_total_transaction_blocks: i64,
    pub network_total_successful_transactions: i64,
    pub network_total_successful_transaction_blocks: i64,
}

#[derive(Debug, Clone)]
pub struct TxCountMetricsDelta {
    pub checkpoint_sequence_number: i64,
    pub epoch: i64,
    pub timestamp_ms: i64,
    pub total_transaction_blocks: i64,
    pub total_successful_transaction_blocks: i64,
    pub total_successful_transactions: i64,
}

impl TxCountMetricsDelta {
    pub fn get_tx_count_metrics_delta(
        tx_batch: &[StoredTransaction],
        latest_stored_checkpoint: &StoredCheckpoint,
    ) -> Self {
        let checkpoint_sequence_number = latest_stored_checkpoint.sequence_number;
        let epoch = latest_stored_checkpoint.epoch;
        let timestamp_ms = latest_stored_checkpoint.timestamp_ms;

        let tx_and_cmd_num_batch: Vec<(StoredTransaction, u64)> = tx_batch
            .iter()
            .filter_map(|tx| {
                let cmd_num_res = tx.get_successful_tx_num();
                if let Ok(cmd_num) = cmd_num_res {
                    Some((tx.clone(), cmd_num))
                } else {
                    tracing::error!(
                        "Failed to get successful tx num for tx: {:?}, error: {:?}",
                        tx,
                        cmd_num_res
                    );
                    None
                }
            })
            .collect();
        let total_transaction_blocks = tx_batch.len() as i64;
        let total_successful_transaction_blocks = tx_and_cmd_num_batch
            .iter()
            .filter(|(_, successful_cmd_num)| *successful_cmd_num > 0)
            .count() as i64;
        let total_successful_transactions = tx_and_cmd_num_batch
            .iter()
            .fold(0, |acc, (_, successful_cmd_num)| {
                acc + *successful_cmd_num as i64
            });
        Self {
            checkpoint_sequence_number,
            epoch,
            timestamp_ms,
            total_transaction_blocks,
            total_successful_transaction_blocks,
            total_successful_transactions,
        }
    }
}

impl StoredTxCountMetrics {
    pub fn combine_tx_count_metrics_delta(
        last_tx_count_metrics: &StoredTxCountMetrics,
        delta: &TxCountMetricsDelta,
    ) -> StoredTxCountMetrics {
        StoredTxCountMetrics {
            checkpoint_sequence_number: delta.checkpoint_sequence_number,
            epoch: delta.epoch,
            timestamp_ms: delta.timestamp_ms,
            total_transaction_blocks: delta.total_transaction_blocks,
            total_successful_transaction_blocks: delta.total_successful_transaction_blocks,
            total_successful_transactions: delta.total_successful_transactions,
            network_total_transaction_blocks: last_tx_count_metrics
                .network_total_transaction_blocks
                + delta.total_transaction_blocks,
            network_total_successful_transactions: last_tx_count_metrics
                .network_total_successful_transactions
                + delta.total_successful_transactions,
            network_total_successful_transaction_blocks: last_tx_count_metrics
                .network_total_successful_transaction_blocks
                + delta.total_successful_transaction_blocks,
        }
    }
}
