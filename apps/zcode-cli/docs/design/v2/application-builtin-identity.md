# Application bundled plugin identity

A trusted distribution may provide ZCODE_APPLICATION_PLUGIN_MARKETPLACE_ID as immutable bootstrap metadata, paired with the application-brand build definition. It is read once at startup, validated as a lowercase marketplace identifier, and defaults to the upstream identity only when absent. Invalid values fail startup. It is not a tenant setting and grants no tool or resource authority.

Shared exported BUNDLED_PLUGIN_MARKETPLACE_ID owns the value. Builtin seed, cache, MCP Host authority, skills, commands, subagents and recovery consume that value; original official remote-source detection is unchanged. SEA asset keys retain their physical packaging identity. An application distribution resolves its bundled marketplace to the local seed partition and never restores the upstream official CDN default. Personal marketplace records remain separate. No new execution or installer is introduced.

Regression requires unchanged upstream defaults, invalid-identity rejection, application discovery without official source, native Host and cache identity consistency, disabled plugin choice preservation and no duplicate builtin loading.
