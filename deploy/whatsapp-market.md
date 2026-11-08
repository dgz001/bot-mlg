# WhatsApp market bridge

The runtime reads MLG_MARKET_BRIDGE_TOKEN and the existing MLG_NEWS_SUPABASE_URL / MLG_NEWS_SUPABASE_KEY. Store only the SHA-256 token hash in private.whatsapp_market_credentials. Never place the bridge token in a browser bundle.

In MLG administrative panel, open Propostas do WhatsApp, authorize the bot in the intended groups, select purchase and trade groups, and verify each WhatsApp participant against the active coach account. Textual @mentions are not proof of identity.

Proposals and quoted responses are saved in the encrypted session vault before delivery. Late positive, negative and withdrawn reactions remain linked to the original message. Unquoted responses require administrative review. These responses inform ADMs; the original requirement for authenticated digital contract signatures remains in effect.

Only a signed contract approved by an ADM can settle a proposal. The database atomically validates the current window, quotas, ownership, availability, balance, latest verified refusal and current contract version before updating the ledger and roster. Repeated approvals return the existing receipt. A matching manual worksheet entry links to the official contract, preventing double counting.

External cards use explicit weekly tiers: A EUR 25,000,000; B EUR 15,000,000; C EUR 10,000,000; D EUR 5,000,000; E EUR 2,000,000. OCR reads the bundled, checksum-verified English model. An unclear or conflicting reading requires ADM review; overall and player fame never determine a weekly tier.

The market reaction worker leases the durable database outbox and acknowledges the exact proposal revision after WhatsApp delivery. Orange means pending, green settled, red rejected. It never changes financial data.

## Local delivery queue and recovery

The WhatsApp worker persists captured proposals and replies in its encrypted session vault before sending them to the platform bridge. The local queue is bounded to 100 proposals and 200 replies; each market tick handles at most 20 due items. When a queue is full, the bot tells the sender that the item was not accepted instead of silently dropping it.

A temporary bridge or persistence error is isolated to that item. Later proposals and responses continue, while the failed item is retried with exponential backoff from 15 seconds up to 15 minutes. Retry metadata is local transport state and is never included in the financial proposal payload.

If the platform reports that a proposal arrived after its batch closed, the worker marks it as terminal locally and sends a stable, idempotent WhatsApp notice. It does not keep submitting the same late proposal to the next batch. The local item is removed only after the notice is confirmed as sent; the notice explicitly states that no balance, roster or contract was changed.

Messages over 16,000 characters are rejected before proposal parsing. Replies are limited to 500 characters and must contain an exact supported confirmation/rejection phrase or reaction. WhatsApp participant identifiers are checked for valid group-member JID shape, including multi-device JIDs.

Card OCR only enriches an already complete text proposal. It may resolve the weekly card tier, but it never invents the player, origin club, destination club or transfer price. Unclear or conflicting readings remain an ADM review item.
