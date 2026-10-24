# Cal Hacks sources for the Sponsorship & Payments Officer seat

These are the facts the seat's company data, policies and answer keys may cite. Anything not listed here is simulated and labeled so (§7). No real organizer, sponsor employee, vendor or team is named; the people are invented names in real roles.

## 1. The organization and the event

- The **Cal Hacks Foundation** is a registered 501(c)(3). Its [Benevity cause page](https://causes.benevity.org/causes/840-813117444?lang=en) describes the event as a 36-hour hackathon in California Memorial Stadium each fall, with donor support covering food, swag and amenities.
- **Cal Hacks 13.0** runs October 23–25, 2026. The Hyphenate track brief dates the in-person workshop to October 23 "an hour after hacking starts"; its venue references (Theater, Mixer Area, Gate 6) are the stadium's.
- The event's site is [calhacks.io](https://calhacks.io) ([GitHub profile](https://www.github.com/calhacks)), which calls it the world's largest collegiate hackathon hosted at UC Berkeley.

## 2. Scale and money: what is public, and what is estimated from it

| Edition | Hackers (Devpost) | Projects (Devpost) | Prizes (Devpost header) | Source in this repository |
|---|---:|---:|---|---|
| Cal Hacks 11.0 (2024) | 1,140 registered | 352 | $188,960 in prizes | `past-winners/past_winners_2024_2025.md` |
| Cal Hacks 12.0 (2025) | 2,161 registered | 699 | $58,100 in cash; the site reported $200,000+ including non-cash | same file |
| Cal Hacks 13.0 (2026) | | | Hyphenate track alone: $8,000, $5,000, $3,000 | `docs/hyphenate/calhacks-hyphenate-track.txt` |

**Sponsorship tiers are not published.** The seat's tiers (Platinum $30,000, Gold $20,000, Silver $12,000, Bronze $6,000) are estimates sized so that eight sponsors plus two track prize funds come to the order of the public prize pools. They are labeled `estimated` in the data, the console and the readme. A real prospectus would replace them in one table.

## 3. When a sponsor's fee is income

A sponsorship fee is consideration for the event; money received before the event is a liability (deferred sponsorship) until the event has happened, then income. This is the same shape as the concert rule the Live Nation seat follows (revenue on the event date; consideration received in advance is deferred, Live Nation 2025 Form 10-K, `docs/live-nation-sources.md` §3). For a nonprofit it is the ordinary treatment of exchange-transaction sponsorships; the seat applies it as a controller-approved policy and does not cite a specific standard.

## 4. Whose money the prize fund is

When a sponsor underwrites a track prize, the foundation holds that money for the winners. It is recorded as owed to the winners (a liability) from the day it is invoiced, and paid out after judging. It is never the foundation's income. Same shape as Live Nation's client cash and ticketing contract advances (`docs/live-nation-sources.md` §3, §5).

## 5. Prizes and the IRS

Prizes and awards of $600 or more paid to a person in a year are reported on Form 1099-MISC (box 3, "Prizes and awards"); the payer collects the winner's taxpayer identification on Form W-9 first. Source: [Instructions for Forms 1099-MISC and 1099-NEC](https://www.irs.gov/instructions/i1099mec) and [Form W-9](https://www.irs.gov/forms-pubs/about-form-w-9). The seat's `tax_form_missing` check is this rule in code: a prize of $600 or more is not approved for payment until the W-9 is on file.

## 6. Card payments

Stripe's published US pricing for a successful card charge is 2.9% + 30¢ ([stripe.com/pricing](https://stripe.com/pricing)). A sponsor that pays by card arrives net of that; the seat books the difference as a card fee under a backtested policy.

## 7. Simulated, and labeled so

- The sponsors, their names, tiers, payer names and payment channels; the holding company that pays for its subsidiary.
- The vendors (stadium services, catering, printing, shuttles, A/V, media), the winning teams, the organizers who are reimbursed.
- Approval limits and the approvers (Logistics Lead $2,500; Sponsorship Lead $10,000; Director of Finance $50,000). Student organizations run approval ladders; the amounts are fixtures.
- The chart of accounts and GL codes.
- Last year's books (Cal Hacks 12.0 as the seat sees it): about 20 sponsor payments and 34 payment requests with the decisions people made, including wire fees of $15–$35 (typical intermediary fees; estimated), card fees at Stripe's rate, one duplicate, and one prize held for a W-9.
- The people: Jordan Lee (Sponsorship Lead) and Ana Reyes (Director of Finance) are invented; every surface marks them simulated when they act.

A planted mistake is never presented as something a real sponsor, vendor or student did.
