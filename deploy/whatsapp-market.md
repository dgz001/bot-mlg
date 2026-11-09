# WhatsApp market bridge

The runtime reads MLG_MARKET_BRIDGE_TOKEN and the existing MLG_NEWS_SUPABASE_URL / MLG_NEWS_SUPABASE_KEY. Store only the SHA-256 token hash in private.whatsapp_market_credentials. Never place the bridge token in a browser bundle.

In MLG administrative panel, open Propostas do WhatsApp, authorize the bot in the intended groups, select purchase and trade groups, and verify each WhatsApp participant against the active coach account. Textual @mentions are not proof of identity.

Proposals and quoted responses are saved in the encrypted session vault before delivery. Late positive, negative and withdrawn reactions remain linked to the original message. Unquoted responses require administrative review. These responses inform ADMs; the original requirement for authenticated digital contract signatures remains in effect.

Only a signed contract approved by an ADM can settle a proposal. The database atomically validates the current window, quotas, ownership, availability, balance, latest verified refusal and current contract version before updating the ledger and roster. Repeated approvals return the existing receipt. A matching manual worksheet entry links to the official contract, preventing double counting.

External cards use explicit weekly tiers: A EUR 25,000,000; B EUR 15,000,000; C EUR 10,000,000; D EUR 5,000,000; E EUR 2,000,000. OCR reads the bundled, checksum-verified English model. An unclear or conflicting reading requires ADM review; overall and player fame never determine a weekly tier.

The market reaction worker leases the durable database outbox and acknowledges the exact proposal revision after WhatsApp delivery. Orange means pending, green settled, red rejected. It never changes financial data.


## Local-only ADM review mode

When the platform bridge is disabled, local transfer proposals are stored in the encrypted session vault and routed to configured ADM groups for manual review. This queue accepts at most 100 unresolved proposals and assigns each one a stable 12-character ticket. ADM commands are available only to WhatsApp group administrators in configured control/market groups:

- `!propostas` — list unresolved proposals (15 per page).
- `!propostas 2` — show the next page.
- `!proposta concluir TICKETID` — close a review that ADMs have already handled outside the bot.

Closing a review only removes it from the pending list. It does not approve a transfer, change a balance, alter a roster or consume a quota. The encrypted archive retains up to 500 recently closed local reviews; unresolved proposals are never pruned automatically. When 100 are pending, new proposals are explicitly rejected with a message instead of being silently discarded.
