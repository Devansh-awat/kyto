---
name: domain-prices
description: 'The live price and availability of a specific domain name ("how much is willmeowfor.money", "is X.dev free", "cheapest place for .ai"), from a registrar''s public API in one call instead of aggregator tables or a browser session. Load before answering any domain price or availability question.'
---

# Domain prices

Aggregator tables (regme.org, tld-list and the like) go stale: one listed Porkbun's `.money` at $8.22 / $26.24 while Porkbun's own checkout said $10.81 / $31.41. Quote a registrar's own live number, and never open a browser for this.

1. **Is the name taken?** RDAP, no key:

   ```bash
   curl -sL -o rdap.json -w '%{http_code}\n' https://rdap.org/domain/willmeowfor.money
   ```

   - `200`: registered. Say who holds it and since when if the JSON has it (`events`, `entities`), and that it isn't for sale at the registration price.
   - `404` with the registry's notices in the body: not registered, so it's available at the standard price below.
   - `404` titled "No RDAP service is available for this resource": the TLD has no RDAP, which tells you nothing. Try `whois <domain>` (install it with `sudo apt-get install -y whois` if missing), or say you couldn't check.

2. **What does it cost?** Porkbun publishes every TLD's price with no key (about 900 TLDs, USD):

   ```bash
   curl -s -X POST https://api.porkbun.com/api/json/v3/pricing/get -H 'Content-Type: application/json' -d '{}' \
     | jq '.pricing["money"]'
   ```

   It returns `registration` (the first year), `renewal` and `transfer`, plus any `coupons`. Always give the first year AND the renewal: a cheap first year with a steep renewal is the usual trap.

3. **Answer** in one go: available or not, then first year / renewal at Porkbun, with the source named ("Porkbun's price list, just now"). If they asked about a different registrar, say this is Porkbun's price and that theirs may differ. Look theirs up only if it has a public price page or API (fetchUrl), not by clicking through a checkout.

Limits, said plainly when they matter:
- **Premium names** (short or dictionary words) can cost far more than the TLD price, and only the registrar's search shows it. Porkbun's per-name check needs an API key kyto doesn't have. For a short or common word, add that it may be priced as premium.
- The price list is per TLD, not per name. Don't present it as a quote for that exact name beyond "standard price".
