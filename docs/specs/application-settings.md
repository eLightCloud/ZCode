# Optional application settings

Trusted Root assembly may provide application-owned settings sections and model-provider entries. Native UI owns selection, sidebar grouping, provider navigation, error isolation and the existing workspace lifecycle. Descriptors contain stable IDs, labels, icons and content renderers; they confer no authorization and persist no business facts.

Sections join the existing basics group or an application-labelled group. Selecting a native section clears the application section. Removed descriptors cannot retain their content. Model entries appear before native providers in the existing split panel; selecting a provider or adding a provider clears the injected entry. Explicit native provider navigation must override an injected selection. Unconfigured native builds retain their existing layout and actions.

Application page assembly may select a header target independently of registration order and mark a page standalone. Standalone pages show their own title instead of sibling navigation. Application settings may link to registered pages; unknown or removed IDs do not open stale content. Close returns focus and preserves the mounted workspace.

Public example: an application registers a basics account section, an administration members section, and a managed model entry. The members renderer can request the model entry through the provided navigation callback, retaining only its own non-sensitive filter. All identities, permissions, credentials and budgets remain with application services; no native settings, execution or provider persistence is mirrored.

Regression: test empty assembly, native/application selection, descriptor removal, standalone page isolation, precise model navigation and provider override; exercise return to a workspace with an unsent draft. Reuse semantic themes, keyboard-accessible controls, desktop chrome and mobile layout.
