import { fmtNumber, isRecord, pick, toNum } from "./format";
import { KeyValueView, Pill, RecordListView, SectionLabel } from "./atoms";
import { GenericHumanView } from "./generic-views";

// ── Monad agent-tool views ──────────────────────────────────────────────────
// monad-tools serialize camelCase structs stamped with a top-level `chain`
// (tools.rs `stamped`). Any unrecognized shape returns the GenericHumanView
// escape hatch rather than null, so a wrong parse never renders nothing.

/** Shorten a 0x-prefixed hash/address for display. */
function short(hash: string): string {
  return hash.length > 16 ? `${hash.slice(0, 10)}…${hash.slice(-6)}` : hash;
}

function ChainTag({ data }: { data: Record<string, unknown> }) {
  const chain = pick<string>(data, "chain");
  if (!chain) return null;
  return <Pill>{chain}</Pill>;
}

/** monad_wallet_status → WalletSnapshot {address, balanceWei, balanceMon,
 *  blockNumber, tokens:[{label, address, available, raw, formatted}], rpcUrl}. */
export function MonadWalletStatusView({ data }: { data: Record<string, unknown> }) {
  const address = pick<string>(data, "address");
  const balance = pick<string>(data, "balanceMon");
  if (!address && !balance) return <GenericHumanView data={data} raw={JSON.stringify(data)} />;
  const tokens = Array.isArray(data.tokens) ? data.tokens.filter(isRecord) : [];
  const blockNum = toNum(pick(data, "blockNumber"));
  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-center gap-2">
        <SectionLabel>Dompet Monad</SectionLabel>
        <ChainTag data={data} />
      </div>
      <div className="bg-card rounded-lg border p-3">
        <div className="flex flex-wrap items-baseline gap-2">
          <span className="text-2xl font-bold">{balance ?? "—"}</span>
          <span className="text-muted-foreground text-sm">MON</span>
        </div>
        <KeyValueView
          entries={
            [
              [
                "Alamat",
                address ? (
                  <span key="addr" className="font-mono text-xs">
                    {short(address)}
                  </span>
                ) : null,
              ],
              [
                "Saldo (wei)",
                <span key="wei" className="font-mono text-xs">
                  {pick<string>(data, "balanceWei")}
                </span>,
              ],
              ["Blok", blockNum != null ? fmtNumber(blockNum) : null],
            ].filter(([, v]) => v != null) as Array<[string, React.ReactNode]>
          }
        />
      </div>
      {tokens.length > 0 && (
        <RecordListView
          items={tokens.map((t) => ({
            title: pick<string>(t, "label") ?? "Token",
            badge: pick(t, "available") === true ? undefined : "tidak tersedia",
            body: `${pick<string>(t, "formatted") ?? "—"} · ${short(pick<string>(t, "address") ?? "")}`,
          }))}
        />
      )}
    </div>
  );
}

/** monad_token_balance / monad_allowance → {token, wallet|owner, spender?,
 *  raw, formatted, decimals, rpcUrl}. */
export function MonadTokenBalanceView({ data }: { data: Record<string, unknown> }) {
  const formatted = pick<string>(data, "formatted");
  const token = pick<string>(data, "token");
  if (!formatted) return <GenericHumanView data={data} raw={JSON.stringify(data)} />;
  const spender = pick<string>(data, "spender");
  return (
    <div className="bg-card space-y-1.5 rounded-lg border p-3">
      <div className="flex flex-wrap items-center gap-2">
        <SectionLabel>{spender ? "Allowance" : "Saldo token"}</SectionLabel>
        <ChainTag data={data} />
      </div>
      <div className="flex items-baseline gap-2">
        <span className="text-2xl font-bold">{formatted}</span>
        {token && <span className="text-muted-foreground font-mono text-xs">{short(token)}</span>}
      </div>
      <KeyValueView
        entries={
          [
            ...(spender
              ? ([
                  [
                    "Spender",
                    <span key="spender" className="font-mono text-xs">
                      {short(spender)}
                    </span>,
                  ],
                ] as Array<[string, React.ReactNode]>)
              : []),
            ["Desimal", pick(data, "decimals") != null ? String(toNum(pick(data, "decimals"))) : null],
            [
              "Raw",
              <span key="raw" className="font-mono text-xs">
                {pick<string>(data, "raw") ?? "—"}
              </span>,
            ],
          ].filter(([, v]) => v != null) as Array<[string, React.ReactNode]>
        }
      />
    </div>
  );
}

/** monad_gas_price → GasEstimate {gasPriceGwei, isDynamicFee, rpcUrl}. */
export function MonadGasView({ data }: { data: Record<string, unknown> }) {
  const gwei = pick<string>(data, "gasPriceGwei");
  if (!gwei) return <GenericHumanView data={data} raw={JSON.stringify(data)} />;
  return (
    <div className="bg-card space-y-1 rounded-lg border p-3">
      <div className="flex items-center gap-2">
        <SectionLabel>Harga gas</SectionLabel>
        <ChainTag data={data} />
      </div>
      <div className="flex items-baseline gap-2">
        <span className="text-2xl font-bold">{gwei}</span>
        <span className="text-muted-foreground text-sm">gwei</span>
        {pick(data, "isDynamicFee") === true && <Pill>dynamic fee</Pill>}
      </div>
    </div>
  );
}

/** monad_chain_status → ChainStatus {rpcUrl, blockNumber, chainId}. */
export function MonadChainStatusView({ data }: { data: Record<string, unknown> }) {
  const block = toNum(pick(data, "blockNumber"));
  const chainId = toNum(pick(data, "chainId"));
  if (block == null && chainId == null) return <GenericHumanView data={data} raw={JSON.stringify(data)} />;
  return (
    <div className="bg-card space-y-1.5 rounded-lg border p-3">
      <div className="flex flex-wrap items-center gap-2">
        <SectionLabel>Status jaringan Monad</SectionLabel>
        <ChainTag data={data} />
      </div>
      <KeyValueView
        entries={
          [
            ["Chain ID", chainId != null ? String(chainId) : null],
            ["Blok terakhir", block != null ? fmtNumber(block) : null],
            [
              "RPC",
              <span key="rpc" className="font-mono text-xs">
                {pick<string>(data, "rpcUrl") ?? "—"}
              </span>,
            ],
          ].filter(([, v]) => v != null) as Array<[string, React.ReactNode]>
        }
      />
    </div>
  );
}

const TX_TONE: Record<string, "up" | "down" | "neutral"> = {
  success: "up",
  failed: "down",
  pending: "neutral",
};

const TX_LABEL: Record<string, string> = { success: "Berhasil", failed: "Gagal", pending: "Tertunda" };

/** monad_tx_receipt → {txHash, status: success|failed|pending, blockNumber?,
 *  explorerUrl}. */
export function MonadTxReceiptView({ data }: { data: Record<string, unknown> }) {
  const hash = pick<string>(data, "txHash");
  const status = pick<string>(data, "status") ?? "pending";
  if (!hash) return <GenericHumanView data={data} raw={JSON.stringify(data)} />;
  const explorer = pick<string>(data, "explorerUrl");
  const block = toNum(pick(data, "blockNumber"));
  return (
    <div className="bg-card space-y-1.5 rounded-lg border p-3">
      <div className="flex flex-wrap items-center gap-2">
        <Pill tone={TX_TONE[status] ?? "neutral"}>{TX_LABEL[status] ?? status}</Pill>
        <ChainTag data={data} />
        <span className="text-muted-foreground ml-auto font-mono text-[11px]" title={hash}>
          {short(hash)}
        </span>
      </div>
      <KeyValueView
        entries={
          [
            ["Blok", block != null ? fmtNumber(block) : null],
            ...(explorer
              ? ([
                  [
                    "Explorer",
                    <a key="explorer" className="text-xs underline" href={explorer} target="_blank" rel="noreferrer">
                      Lihat transaksi ↗
                    </a>,
                  ],
                ] as Array<[string, React.ReactNode]>)
              : []),
          ].filter(([, v]) => v != null) as Array<[string, React.ReactNode]>
        }
      />
    </div>
  );
}

/** monad_logs → TransferScan {token, address, fromBlock, toBlock,
 *  scannedBlocks, transfers:[{txHash, blockNumber, direction, counterparty,
 *  amountRaw}], truncated, rangeShrunk} + tokenLabel. */
export function MonadLogsView({ data }: { data: Record<string, unknown> }) {
  const transfers = Array.isArray(data.transfers) ? data.transfers.filter(isRecord) : [];
  if (transfers.length === 0 && !isRecord(data)) return <GenericHumanView data={data} raw={JSON.stringify(data)} />;
  const label = pick<string>(data, "tokenLabel") ?? pick<string>(data, "token") ?? "Transfer";
  const scanned = toNum(pick(data, "scannedBlocks"));
  return (
    <div className="space-y-2">
      <SectionLabel>
        {label} — {transfers.length} transfer
        {scanned != null ? ` (memindai ${fmtNumber(scanned)} blok)` : ""}
        {pick(data, "truncated") === true && " · hasil dipotong"}
      </SectionLabel>
      {transfers.length === 0 ? (
        <p className="text-muted-foreground text-sm">Tidak ada transfer ditemukan pada rentang ini.</p>
      ) : (
        <ul className="space-y-1.5">
          {transfers.slice(0, 15).map((t, i) => {
            const dir = pick<string>(t, "direction");
            const incoming = dir === "in" || dir === "incoming";
            const hash = pick<string>(t, "txHash") ?? "";
            const block = toNum(pick(t, "blockNumber"));
            return (
              // biome-ignore lint/suspicious/noArrayIndexKey: transfer lists may repeat tx hashes
              <li key={i} className="bg-card flex items-center gap-3 rounded-lg border px-3 py-2">
                <Pill tone={incoming ? "up" : "neutral"}>{incoming ? "↓ masuk" : "↑ keluar"}</Pill>
                <div className="min-w-0 flex-1">
                  <div
                    className="text-muted-foreground truncate font-mono text-xs"
                    title={pick<string>(t, "counterparty") ?? ""}
                  >
                    {pick<string>(t, "counterparty") ?? "—"}
                  </div>
                  <div className="text-muted-foreground font-mono text-[10px]">
                    {hash && <span title={hash}>{short(hash)}</span>}
                    {block != null ? ` · blok ${fmtNumber(block)}` : ""}
                  </div>
                </div>
                <span className="shrink-0 font-mono text-xs">{pick<string>(t, "amountRaw") ?? "—"}</span>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}

/** monad_token_info → TokenInfo {address, symbol, decimals, rpcUrl}. */
export function MonadTokenInfoView({ data }: { data: Record<string, unknown> }) {
  const symbol = pick<string>(data, "symbol");
  const address = pick<string>(data, "address");
  if (!symbol && !address) return <GenericHumanView data={data} raw={JSON.stringify(data)} />;
  return (
    <div className="bg-card space-y-1.5 rounded-lg border p-3">
      <div className="flex flex-wrap items-center gap-2">
        <span className="font-mono text-sm font-semibold">{symbol ?? "Token"}</span>
        <ChainTag data={data} />
      </div>
      <KeyValueView
        entries={
          [
            [
              "Alamat",
              <span key="addr" className="font-mono text-xs">
                {address ?? "—"}
              </span>,
            ],
            ["Desimal", pick(data, "decimals") != null ? String(toNum(pick(data, "decimals"))) : null],
            [
              "RPC",
              <span key="rpc" className="font-mono text-xs">
                {pick<string>(data, "rpcUrl") ?? "—"}
              </span>,
            ],
          ].filter(([, v]) => v != null) as Array<[string, React.ReactNode]>
        }
      />
    </div>
  );
}
