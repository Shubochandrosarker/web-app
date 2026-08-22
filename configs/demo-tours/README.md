# demo-tours — fixture tenant

A **fictional** tour operator, marked `environment.releaseEligible: false`
like every fixture: it can never gate or be the subject of a release, and
nothing in it describes a real business.

Where `demo-consultancy` proves the platform is not NuESheba-shaped,
`demo-tours` proves the closeout modules are not education-shaped: it
enables the full operations stack — services (as tours), scheduling with
availability rules and capacity (group departures are exactly the
`capacity > 1` case), orders with manual payments in a third currency,
first-party reviews and locations — under a different business type,
country, time zone and vocabulary, with zero code changes.

Provision it locally to click through the whole surface:

```sh
pnpm run workspace:provision demo-tours --owner-email you@example.com
pnpm run workspace:seed-smoke demo-tours
```
