# Currency Exchange API — how to get data for item X

Runbook for pulling data on a single item (a currency/scarab/fragment/etc.) from
GGG's **async Currency Exchange** (the Faustus market). Verified against live data
2026-07-21. This is NOT the synchronous whisper trade (`/api/trade/exchange/{league}`);
it returns aggregate market digests with no listings/accounts/whispers.

## Endpoint

```
GET https://web.poecdn.com/api/currency-exchange[/<realm>][/<id>]
```

- **No OAuth.** Send an identifiable `User-Agent` with a contact address.
- `<realm>` (optional): `xbox` | `sony` | `poe2`. **Omit for PoE1 PC.**
- `<id>` (optional): Unix timestamp of the hour to fetch (see cursor rules).
- Realm vs id are positional: `.../currency-exchange/<id>` (numeric) = PC at that
  hour; `.../currency-exchange/poe2/<id>` = poe2 realm at that hour.

## Cursor / time rules (important)

- Data is **hourly digests**. An item appears in an hour ONLY if it traded that hour.
- No `<id>` → returns the **oldest** digest (Settlers launch, 2024-07-26). Not what
  you want for "current price."
- Pass `<id>` = a **top-of-hour** Unix timestamp (`ts - ts % 3600`).
- The **current** hour returns **404** (still in progress). Use `now_hour - 3600`
  for the most recent complete hour.
- Each response carries `next_change_id` = the next hour to fetch; walk forward with it.
- ~5-minute delay on results; current-hour data is never available.

## Steps to get item X for league L

1. Pick the hour: `ts = (floor(now/3600)*3600) - 3600`.
2. Fetch `https://web.poecdn.com/api/currency-exchange/<ts>` (HTTP 200 expected).
3. Filter `.markets[]` by `.league == "L"` (exact string, e.g. `"Standard"`,
   `"Hardcore"`; temp leagues use their display name).
4. Find X by its **metadata id** inside `.market_pair` (see "Identifying X").
5. Read the fields off each matching market object.

## Identifying X (metadata ids, not display names)

Markets are keyed by internal metadata ids, e.g.:
- Chaos Orb = `Metadata/Items/Currency/CurrencyRerollRare`
- Divine Orb = `Metadata/Items/Currency/CurrencyModValues`
- Legion Scarab (base) = `Metadata/Items/Scarabs/ScarabLegionNew1`

An item usually trades in several markets (one per counter-currency). Match with a
substring/regex on the leaf id. There is **no display-name field**; the id→name map
lives in the trade site's `data/static`, which is Cloudflare-gated (needs a browser
session). For testing, match by metadata id directly.

## Response shape (per market object)

```json
{
  "league": "Standard",
  "market_id": "<idA>|<idB>",
  "market_pair": ["<idA>", "<idB>"],
  "volume_traded": { "<idA>": 56,   "<idB>": 662 },   // units traded this hour
  "lowest_stock":  { "<idA>": 0,    "<idB>": 5008 },  // min open order-book depth
  "highest_stock": { "<idA>": 44,   "<idB>": 5142 },  // max open order-book depth
  "lowest_ratio":  { "<idA>": 1,    "<idB>": 12 },    // price: 1 A = 12 B
  "highest_ratio": { "<idA>": 1,    "<idB>": 11 }     // price range that hour
}
```

- `*_ratio` is the price as an integer pair; the side fixed at 1 (or a small int) is
  the unit. `lowest`/`highest` bracket the hour's price range.
- Aggregate only: **no accounts, offers, or whisper tokens.**

## Copy-paste test (bash + jq): base Legion Scarab on Standard

```bash
UA="OAuth <yourname>/1.0 (contact: you@example.com)"
now=$(date -u +%s); ts=$(( now - now % 3600 - 3600 ))   # last complete hour
curl -sS -H "User-Agent: $UA" \
  "https://web.poecdn.com/api/currency-exchange/$ts" \
| jq '.markets[]
       | select(.league=="Standard")
       | select(.market_pair[] | test("ScarabLegionNew1$"))'
```

Swap the `test("...")` pattern and `.league` for any other item/league. If the result
is empty, X did not trade that hour — step back an hour (`ts -= 3600`) and retry.
