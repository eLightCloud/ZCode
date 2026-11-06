# Automation execution capabilities

The selected execution host owns dispatch availability and cron timezone. This module only reads
`IZCodeAgentService.getAutomationCapabilities`; it does not infer capabilities from the browser,
provider selection, or rule enabled state. Switching host or disconnecting immediately invalidates
the previous read. Late responses cannot replace the new host's state. An unavailable read blocks
manual dispatch and displays an explicit retry action; saving the rule remains possible.

Desktop and Web use the same service contract and selected workspace routing. Scheduler admission
remains authoritative if deployment changes after the read. Timezone labels use the host's IANA
timezone, including DST at the displayed next run, never the browser's offset.
