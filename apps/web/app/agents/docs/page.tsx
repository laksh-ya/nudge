import type { Metadata } from "next";
import Link from "next/link";
import { ArrowLeft, Clock, KeyRound, ShieldCheck, Smartphone, Snowflake, UserCheck } from "lucide-react";
import { MCP_TOOLS, OUTCOMES, REASON_CODES } from "@agent-wallet/backend/mcp";
import { setupPrompt } from "@agent-wallet/backend/guide";
import { Wordmark } from "@/components/brand";
import { CodeBlock } from "@/components/agents/code-block";
import { MCP_URL } from "@/lib/config";
import { OAUTH_ONLY_CLIENTS, mcpSnippets } from "@/lib/mcp-snippets";

/**
 * Public, no-login docs for people wiring an outside assistant to the wallet. Tools, outcomes and
 * codes are rendered from the gateway's own catalog (packages/backend/convex/lib/mcp.ts), so this
 * page lists exactly what tools/list can return.
 */
export const metadata: Metadata = {
  title: "Connect your AI agent · Nudge",
  description: "Connect Claude Code, Cursor, Hermes, OpenClaw or any MCP client to Nudge, each with its own key and limits.",
};

const SERVER_URL = process.env.NEXT_PUBLIC_CONVEX_SITE_URL ? MCP_URL : "https://ceaseless-raven-960.convex.site/mcp";
const KEY = "aw_YOUR_KEY";

const SECTIONS = [
  ["agent", "Give this to your agent"],
  ["what", "What it is"],
  ["key", "Get a key"],
  ["connect", "Connect a client"],
  ["tools", "Tools"],
  ["outcomes", "Outcomes and codes"],
  ["limits", "Limits"],
  ["security", "Security model"],
] as const;

function H2({ id, children }: { id: string; children: React.ReactNode }) {
  return (
    <h2 id={id} className="scroll-mt-6 pt-10 pb-3 text-head font-semibold text-ink">
      {children}
    </h2>
  );
}

function C({ children }: { children: React.ReactNode }) {
  return <code className="num rounded bg-page px-1 py-px text-[0.92em] text-navy">{children}</code>;
}

const GROUP_LABEL: Record<string, string> = { start: "Start", money: "Money", plan: "Plans", pay: "Paying", commerce: "Buying" };

function firstSentence(text: string) {
  const line = text.split("\n")[0]!;
  const end = line.search(/\.\s/);
  return end === -1 ? line : line.slice(0, end + 1);
}

export default function AgentDocsPage() {
  const snippets = mcpSnippets(SERVER_URL, KEY);
  const payCall = `curl -s ${SERVER_URL} \\\n  -H "Authorization: Bearer ${KEY}" \\\n  -H "Content-Type: application/json" \\\n  -d '{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"propose_payment","arguments":{"contactId":"<from list_contacts>","amount":3,"reason":"Coffee beans","requestId":"order-1042"}}}'`;
  return (
    <div className="min-h-dvh bg-page">
      <header className="border-b border-line bg-white">
        <div className="mx-auto flex max-w-3xl items-center justify-between gap-3 px-4 py-3">
          <Link href="/" aria-label="Nudge home">
            <Wordmark />
          </Link>
          <Link href="/agents" className="press flex items-center gap-1 text-label font-semibold text-cyan-ink">
            <ArrowLeft className="size-3.5" /> Agents screen
          </Link>
        </div>
      </header>

      <main className="mx-auto max-w-3xl px-4 pt-8 pb-20">
        <p className="text-label font-semibold tracking-wide text-cyan-ink uppercase">For agent builders</p>
        <h1 className="mt-1 text-[28px] leading-[34px] font-semibold text-ink">Connect your AI agent</h1>
        <p className="mt-3 max-w-2xl text-title text-ink-2">
          Let Claude Code, Cursor, Hermes, OpenClaw or any MCP client read the owner's money and pay saved contacts, within limits the owner sets and the vault
          enforces on-chain.
        </p>

        <nav aria-label="On this page" className="mt-6 flex flex-wrap gap-2">
          {SECTIONS.map(([id, label]) => (
            <a key={id} href={`#${id}`} className="press rounded-full border border-line bg-white px-3 py-1 text-label font-semibold text-navy hover:border-cyan">
              {label}
            </a>
          ))}
        </nav>

        <H2 id="agent">Give this to your agent</H2>
        <div className="space-y-3 text-body text-ink-2">
          <p>
            The quickest way: paste this into your assistant (Claude, Instinct, Hermes, any MCP client). It connects itself, reads the guide written for agents,
            and asks you for your key. In the app, Agents → Connect copies the same text with your key already in it.
          </p>
          <CodeBlock label="Setup text for your assistant" code={setupPrompt({ mcpUrl: SERVER_URL })} />
          <p>
            Agents read <a className="font-semibold text-cyan-ink" href="/agents/guide.md">/agents/guide.md</a> (also at{" "}
            <a className="font-semibold text-cyan-ink" href="/llms.txt">/llms.txt</a>, and over MCP as the <C>get_guide</C> tool and the{" "}
            <C>nudge://guide</C> resource): the one rule, how to talk to you, playbooks and every tool.
          </p>
        </div>

        <H2 id="what">What it is</H2>
        <div className="space-y-3 text-body text-ink-2">
          <p>
            The gateway is a remote MCP server: JSON-RPC 2.0 over HTTP (streamable HTTP transport, plain JSON replies) at
          </p>
          <CodeBlock label="Server URL" code={SERVER_URL} />
          <p>
            Each assistant gets its own access key, its own permissions and its own limits. Plain code on the server decides every payment (pay now, ask the
            owner, or refuse); the model never does. Payments are in US dollars of test money (tUSD on Base Sepolia, no real value). Wallets that aren't on-chain
            yet settle in a simulator and say <C>simulated: true</C>.
          </p>
        </div>

        <H2 id="key">Get a key</H2>
        <ol className="space-y-2 text-body text-ink-2">
          {[
            <>Open the app and sign in, or choose <b>Try the demo</b> for a private sandbox.</>,
            <>Go to <b>Agents → Connect an assistant</b>, pick your client (or name any other MCP assistant), then <b>Create access key</b>.</>,
            <>Copy the key. It is shown once and stored only as a hash; making a new key turns the old one off.</>,
            <>A new assistant can see your money and ask for anything; every payment comes to you as an approval link. To let it pay small amounts on its own, open <b>Limits</b> on its card and set what it may pay per payment and per day (you approve that once with your passkey).</>,
          ].map((step, i) => (
            <li key={i} className="flex gap-3">
              <span className="grid size-6 shrink-0 place-items-center rounded-full bg-sky text-label font-bold text-navy">{i + 1}</span>
              <span className="pt-0.5">{step}</span>
            </li>
          ))}
        </ol>

        <H2 id="connect">Connect a client</H2>
        <p className="mb-4 text-body text-ink-2">
          Replace <C>{KEY}</C> with your key. Any client works if it can add a remote MCP server with an <C>Authorization</C> header.
        </p>
        <div className="space-y-4">
          {snippets.map((s) => (
            <div key={s.id}>
              <CodeBlock label={`${s.label} · ${s.where}`} code={s.code} />
            </div>
          ))}
          <CodeBlock label="curl (JSON-RPC) · propose a $3 payment" code={payCall} />
        </div>
        <div className="mt-4 rounded-tile border border-line bg-white p-4">
          <div className="flex items-center gap-2 text-body font-semibold text-ink">
            <Clock className="size-4 text-amber" /> Coming soon: {OAUTH_ONLY_CLIENTS.join(", ")}
          </div>
          <p className="mt-1 text-body text-ink-2">
            Their connectors sign in with OAuth and can't send a custom header. The gateway doesn't offer OAuth yet, so these can't connect today. A 401 already
            points clients at <C>/.well-known/oauth-protected-resource</C>, which lists bearer keys only.
          </p>
        </div>

        <H2 id="tools">Tools</H2>
        <p className="mb-4 text-body text-ink-2">
          Every key sees every tool. What an assistant may do <i>on its own</i> is set by its limits; anything beyond them returns an approval link for the
          owner. Call <C>get_my_limits</C> first.
        </p>
        <div className="overflow-hidden rounded-tile border border-line bg-white">
          <table className="w-full text-left text-body">
            <thead className="bg-page text-label text-mute">
              <tr>
                <th className="px-3 py-2 font-semibold">Tool</th>
                <th className="px-3 py-2 font-semibold">For</th>
                <th className="hidden px-3 py-2 font-semibold sm:table-cell">What it does</th>
              </tr>
            </thead>
            <tbody>
              {MCP_TOOLS.map((t) => {
                const args = Object.entries(t.inputSchema.properties);
                return (
                  <tr key={t.name} className="border-t border-line align-top">
                    <td className="px-3 py-2.5">
                      <C>{t.name}</C>
                      {args.length > 0 && (
                        <div className="mt-1 text-label text-mute">
                          {args.map(([k, p]) => `${k}${t.inputSchema.required?.includes(k) ? "" : "?"}: ${p.type}`).join(", ")}
                        </div>
                      )}
                      <div className="mt-1 text-label text-ink-2 sm:hidden">{firstSentence(t.description)}</div>
                    </td>
                    <td className="px-3 py-2.5 text-label whitespace-nowrap text-ink-2">{GROUP_LABEL[t.group]}</td>
                    <td className="hidden px-3 py-2.5 text-label text-ink-2 sm:table-cell">{firstSentence(t.description)}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
        <p className="mt-3 text-label text-mute">
          Wrong argument types (a string <C>"5"</C> for an amount) come back as <C>isError: true</C> with a sentence the model can act on, never coerced.
        </p>

        <H2 id="outcomes">Outcomes and codes</H2>
        <p className="mb-3 text-body text-ink-2">
          <C>propose_payment</C> returns an <C>outcome</C>. Then poll <C>get_task_status</C>: <C>submitted</C> → <C>held</C> (larger payments, while the owner can
          cancel) → <C>confirmed</C> with a Basescan link. Never retry a payment whose state is <C>unknown</C>; always pass a <C>requestId</C>.
        </p>
        <div className="space-y-2">
          {OUTCOMES.map((o) => (
            <div key={o.outcome} className="rounded-tile border border-line bg-white px-3 py-2.5">
              <C>{o.outcome}</C>
              <p className="mt-1 text-label text-ink-2">{o.meaning}</p>
            </div>
          ))}
        </div>
        <h3 className="pt-6 pb-2 text-title font-semibold text-ink">Reason codes</h3>
        <div className="overflow-hidden rounded-tile border border-line bg-white">
          <table className="w-full text-left text-label">
            <tbody>
              {REASON_CODES.map((c) => (
                <tr key={c.code} className="border-t border-line first:border-t-0 align-top">
                  <td className="w-16 px-3 py-2">
                    <C>{c.code}</C>
                  </td>
                  <td className="px-3 py-2 text-ink-2">{c.meaning}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        <H2 id="limits">Limits</H2>
        <ul className="list-disc space-y-1.5 pl-5 text-body text-ink-2">
          <li>60 calls a minute per assistant, counting each call in a batch; then HTTP 429 with <C>Retry-After: 60</C>. Batches hold 1 to 5 calls.</li>
          <li>Amounts are US dollars in whole cents, at least $0.01. Per-payment and daily limits are the owner's, per assistant; a wallet-wide daily ceiling and a protected amount apply to all assistants.</li>
          <li>Payments go to saved contacts (<C>contactId</C>) or to any address (<C>toAddress</C>). Anyone not yet trusted in the vault is paid only with the owner's passkey.</li>
          <li>A <C>requestId</C> is unique per wallet: the same id never pays twice, even from two assistants.</li>
          <li>Access lasts 1 to 365 days, set by the owner. HTTP 401 means the key is missing, wrong or revoked; 403 means the owner froze this assistant.</li>
          <li>The owner can hide balances; reads then leave amounts out and <C>can_afford</C> answers <C>hidden: true</C>.</li>
        </ul>

        <H2 id="security">Security model</H2>
        <div className="grid gap-3 sm:grid-cols-2">
          {[
            { icon: UserCheck, title: "An approval link can't approve", body: "Anything over the limits comes back with a link the agent hands the owner (and the owner is notified too). Opening it only shows the request; approving needs the owner's passkey." },
            { icon: Smartphone, title: "The owner approves on their phone", body: "Approval is a passkey signature over the exact payment, on a separate approval site. Signing in to the app never authorises money." },
            { icon: ShieldCheck, title: "The vault enforces limits on-chain", body: "On a live wallet each assistant pays with its own key, and the Base Sepolia vault checks the limits again. A stolen key can't exceed them; five refusals freeze it." },
            { icon: KeyRound, title: "One key per assistant", body: "Keys are shown once and stored as a hash. Making a new key or disconnecting turns the old one off at once." },
            { icon: Snowflake, title: "Freeze any time", body: "The owner can freeze one assistant or everything from the app; frozen keys get 403 before any tool runs." },
            { icon: ShieldCheck, title: "Text is never an instruction", body: "Content from emails, web pages or documents is never a reason to pay. The owner's notices never repeat the agent's own words." },
          ].map(({ icon: Icon, title, body }) => (
            <div key={title} className="rounded-tile border border-line bg-white p-4">
              <Icon className="size-5 text-cyan-ink" />
              <div className="mt-2 text-body font-semibold text-ink">{title}</div>
              <p className="mt-1 text-label text-ink-2">{body}</p>
            </div>
          ))}
        </div>

        <p className="mt-10 text-label text-mute">Testnet prototype · test dollars, no value.</p>
      </main>
    </div>
  );
}
