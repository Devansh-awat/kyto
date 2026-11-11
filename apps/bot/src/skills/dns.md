---
name: dns
description: 'Domain nameservers and DNS basics: what a registrar''s nameservers are, which ones a domain uses now, why there are two or more, setting records. Load before naming any domain''s nameservers or explaining NS records.'
---

# DNS and nameservers

Never name a domain's nameservers from memory. Look them up this turn, and say what the lookup returned:

```bash
curl -s 'https://dns.google/resolve?name=example.com&type=NS' | jq '.Answer[].data'
```

(`type=A`, `MX`, `TXT` for other records; `https://cloudflare-dns.com/dns-query?name=...&type=NS` with header `accept: application/dns-json` is a second opinion.) A new domain not yet pointed at a host returns the registrar's default servers; a changed delegation can take up to the old NS TTL to show.

## Spaceship

Spaceship's default nameservers are `launch1.spaceship.net` and `launch2.spaceship.net` (the **.net**, not .com), confirmed by live lookups of a Spaceship-hosted domain. Spaceship's "Custom nameservers" setting replaces them wholesale with the host's own pair (Cloudflare, Vercel, etc.), so always check the domain's current NS before quoting them.

## Why two or more

- A public delegated zone must be registered with **at least two** nameservers: RFC 2182 §5 says the DNS specification and registration rules require at least two servers for every zone, and most registries reject one. Never say "DNS only needs one".
- The reason is availability: if one is unreachable the other still answers; they should be on different networks or locations (RFC 2182 §3).
- Don't promise load balancing. Resolvers may measure response times and prefer the faster server, which spreads load only loosely.
- When changing nameservers, enter ALL the host's servers, not one.
