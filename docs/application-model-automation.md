# Application model automation

An application-managed model may support a user's native automations without a separate service account. The trusted application transport declares `ZCODE_APPLICATION_MODEL_AUTOMATION=user` in the execution environment; missing or unknown values keep the existing rejection. It is a startup transport capability, not a user preference, provider setting, model permission or permission grant.

The provider package owns the single pure capability parser. Both native automation submission (`automationModelSelection`) and actual application model transport (`AiSdkModelExecution`) consume it. The latter also covers derived and resumed automation model calls; runtime invocation provenance is unchanged. Personal providers and applications without this declaration retain their behavior.

The application owns current account and resource admission on every request. A server transport must bind its workload proof to the original user and instance and reject revoked or changed ownership. A desktop broker must also bind a saved rule to its original user and reject account changes before it can declare this capability. Authenticating only the current application session is insufficient; applications without that binding must keep desktop application-model automation disabled. The declaration does not make an expired session valid, move local connections to a server, keep a closed desktop process running, or change native schedules, queues, restoration, approvals and model billing.

Verification covers default and malformed capability rejection, explicit user capability at dispatch and real transport, immutable automation provenance, original credential forwarding and later human turns. End-to-end account revocation belongs to the integrating application's tests.

## Saved application selection

When a trusted application supports user automations, new rules without an explicit model persist the application's current preferred selection at creation. Existing unbound rules cannot acquire the current application default at their first run. The integrating application supplies account-scoped provider identities and headers; the desktop broker requires and forwards those fixed headers with its current session; the application backend verifies the fixed account scope against the authenticated user on every call before obtaining any model key. Account changes reject an old selection, including cached and resumed calls. The integrating backend still owns final current-user, model and quota authorization.

An application default is an initial recommendation, not an existing run selection. If its reasoning level is unsupported but the same visible provider and model remain available, native initialization completes that model using its supported levels. A removed or hidden model stays unavailable; this does not repair or retarget saved run selections.

The execution process sends its private application credential only to the transport URL declared by trusted startup. A public URL advertised in model metadata is not an authority for credential routing. Account-scoped headers and immutable invocation provenance remain attached to the saved provider snapshot.

## Editing an account-bound rule

An application provider identifies the original application model account. Updating a saved rule may change its model and options within that provider, but cannot replace or clear the provider identity. Switching to another application or personal provider requires a new rule. This also prevents an account switch followed by an explicit model save from transferring an old rule. Personal-provider rules retain native editing behavior; no second ownership table is introduced. Rejection happens in AutomationService before any repository update, and the UI keeps the draft with an account-binding explanation.
