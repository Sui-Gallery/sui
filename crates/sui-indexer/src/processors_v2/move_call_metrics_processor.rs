// Copyright (c) Mysten Labs, Inc.
// SPDX-License-Identifier: Apache-2.0

// similar to AddressMetricsProcessor in address_metrics_processor.rs

use std::collections::HashMap;
use tracing::{error, info};

use crate::errors::IndexerError;
use crate::models_v2::move_call_metrics::{DerivedMoveCallInfo, StoredMoveCall};
use crate::store::IndexerAnalyticalStore;
use crate::types_v2::IndexerResult;

const MOVE_CALL_PROCESSOR_BATCH_SIZE: i64 = 1000;

pub struct MoveCallMetricsProcessor<S> {
    pub store: S,
}

impl<S> MoveCallMetricsProcessor<S>
where
    S: IndexerAnalyticalStore + Sync + Send + 'static,
{
    pub fn new(store: S) -> MoveCallMetricsProcessor<S> {
        Self { store }
    }

    pub async fn start(&self) -> IndexerResult<()> {
        info!("Indexer move call metrics async processor started...");

        let latest_move_call_metrics = self
            .store
            .get_latest_move_call_metrics()
            .await
            .unwrap_or_default();
        let mut last_end_cp_seq = latest_move_call_metrics.checkpoint_sequence_number;
        loop {
            let mut latest_stored_checkpoint = self.store.get_latest_stored_checkpoint().await?;
            while latest_stored_checkpoint.sequence_number
                < last_end_cp_seq + MOVE_CALL_PROCESSOR_BATCH_SIZE
            {
                tokio::time::sleep(std::time::Duration::from_secs(1)).await;
                latest_stored_checkpoint = self.store.get_latest_stored_checkpoint().await?;
            }
            // +1 here b/c get_transactions_in_checkpoint_range is left-inclusive, right-exclusive,
            // but we want left-exclusive, right-inclusive, as latest_tx_count_metrics has been processed.
            let cps = self
                .store
                .get_checkpoints_in_range(
                    last_end_cp_seq + 1,
                    last_end_cp_seq + MOVE_CALL_PROCESSOR_BATCH_SIZE + 1,
                )
                .await?;
            let end_cp = cps
                .last()
                .ok_or(IndexerError::PostgresReadError(
                    "Cannot read checkpoint from PG for move call metrics".to_string(),
                ))?
                .clone();
            let cp_epoch_map = cps
                .iter()
                .map(|cp| (cp.sequence_number, cp.epoch))
                .collect::<HashMap<_, _>>();
            let txs = self
                .store
                .get_transactions_in_checkpoint_range(
                    last_end_cp_seq + 1,
                    end_cp.sequence_number + 1,
                )
                .await?;
            let tx_cp_map = txs
                .iter()
                .map(|tx| (tx.tx_sequence_number, tx.checkpoint_sequence_number))
                .collect::<HashMap<_, _>>();
            let start_tx_seq = txs
                .first()
                .ok_or(IndexerError::PostgresReadError(
                    "Cannot read first tx from PG for move call metrics".to_string(),
                ))?
                .tx_sequence_number;
            let end_tx_seq = txs
                .last()
                .ok_or(IndexerError::PostgresReadError(
                    "Cannot read last tx from PG for move call metrics".to_string(),
                ))?
                .tx_sequence_number;

            let stored_move_calls = self
                .store
                .get_move_calls_in_tx_range(start_tx_seq, end_tx_seq + 1)
                .await?;
            let derived_move_calls = stored_move_calls
                .into_iter()
                .filter_map(|call| {
                    let mut split = call.func.split("::");
                    let package = split.next()?;
                    let module = split.next()?;
                    let function = split.next()?;
                    let cp = tx_cp_map.get(&call.tx_sequence_number)?;
                    Some(DerivedMoveCallInfo {
                        tx_sequence_number: call.tx_sequence_number,
                        checkpoint_sequence_number: *cp,
                        move_package: package.to_string(),
                        move_module: module.to_string(),
                        move_function: function.to_string(),
                    })
                })
                .collect::<Vec<DerivedMoveCallInfo>>();

            let end_cp_seq = end_cp.sequence_number;
            let move_calls_to_commit = derived_move_calls
                .into_iter()
                .filter_map(|derived_move_call_info| {
                    if let Some(epoch) =
                        cp_epoch_map.get(&derived_move_call_info.checkpoint_sequence_number)
                    {
                        Some(StoredMoveCall {
                            id: None,
                            transaction_sequence_number: derived_move_call_info.tx_sequence_number,
                            checkpoint_sequence_number: derived_move_call_info
                                .checkpoint_sequence_number,
                            epoch: *epoch,
                            move_package: derived_move_call_info.move_package,
                            move_module: derived_move_call_info.move_module,
                            move_function: derived_move_call_info.move_function,
                        })
                    } else {
                        error!(
                            "checkpoint {} not found in cp_epoch_map",
                            derived_move_call_info.checkpoint_sequence_number
                        );
                        None
                    }
                })
                .collect::<Vec<_>>();
            self.store.persist_move_calls(move_calls_to_commit).await?;
            info!("Persisted move_calls for checkpoint: {}", end_cp_seq);

            let move_call_metrics = self.store.calculate_move_call_metrics(end_cp).await?;
            self.store
                .persist_move_call_metrics(move_call_metrics)
                .await?;
            last_end_cp_seq = end_cp_seq;
            info!("Persisted move_call_metrics for checkpoint: {}", end_cp_seq);
        }
    }
}
