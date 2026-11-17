// Every part of the hub, one line each. Order = order of panels on their group page.
// To remove a part: delete its line (and its file). To add one: write src/modules/<id>.ts, add a line.
// To switch a part off for one person only: leave it here and list the ids they want in data/config.json "modules"
// (none listed = config.ts DEFAULT_MODULES; docs/config.md).
import type { Module } from './core/types.ts'
import { agents } from './modules/agents.ts'
import { bridge } from './modules/bridge/index.ts'
import { consoles } from './modules/consoles.ts'
import { crash } from './modules/crash.ts'
import { develop } from './modules/develop/index.ts'
import { gmail } from './modules/gmail.ts'
import { jira } from './modules/jira.ts'
import { listing } from './modules/listing.ts'
import { market } from './modules/market.ts'
import { notifyModule } from './modules/notify/index.ts'
import { rc } from './modules/rc.ts'
import { repos } from './modules/repos.ts'
import { report } from './modules/report/index.ts'
import { segsync } from './modules/segsync.ts'
import { track } from './modules/track/index.ts'

export const MODULES: Module[] = [
  // Develop
  develop,
  jira,
  // Report
  report,
  // Theo dõi
  track,
  // Vận hành
  agents,
  repos,
  crash,
  rc,
  segsync,
  market,
  consoles,
  bridge,
  notifyModule,
  // Phản hồi
  gmail,
  listing,
]
