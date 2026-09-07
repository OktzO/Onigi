/**
 * Creates a processor for offline stanza nodes that:
 * - Queues nodes for sequential processing
 * - Yields to the event loop periodically to avoid blocking
 * - Catches handler errors to prevent the processing loop from crashing
 */
export function makeOfflineNodeProcessor(nodeProcessorMap, deps, batchSize = 10) {
    const nodes = [];
    const MAX_QUEUE = 5000;
    let isProcessing = false;
    const enqueue = (type, node) => {
        // cap: backlog offline besar = node terdekode penuh resident di RAM;
        // drop baru saat penuh (server kirim ulang via offline preview count)
        if (nodes.length >= MAX_QUEUE) {
            return;
        }
        nodes.push({ type, node });
        if (isProcessing) {
            return;
        }
        isProcessing = true;
        const promise = async () => {
            let processedInBatch = 0;
            while (nodes.length && deps.isWsOpen()) {
                const { type, node } = nodes.shift();
                const nodeProcessor = nodeProcessorMap.get(type);
                if (!nodeProcessor) {
                    deps.onUnexpectedError(new Error(`unknown offline node type: ${type}`), 'processing offline node');
                    continue;
                }
                await nodeProcessor(node).catch(err => deps.onUnexpectedError(err, `processing offline ${type}`));
                processedInBatch++;
                // Yield to event loop after processing a batch
                // This prevents blocking the event loop for too long when there are many offline nodes
                if (processedInBatch >= batchSize) {
                    processedInBatch = 0;
                    await deps.yieldToEventLoop();
                }
            }
            // WS dropped mid-drain — drop the rest instead of holding stale nodes in memory
            if (!deps.isWsOpen()) {
                nodes.length = 0;
            }
            isProcessing = false;
        };
        promise().catch(error => deps.onUnexpectedError(error, 'processing offline nodes'));
    };
    return { enqueue };
}
//# sourceMappingURL=offline-node-processor.js.map