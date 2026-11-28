# Hosted handoff release gate for v0.2.0

The CLI fixes and credential-free demo are merged. The hosted handoff is blocked on the Gateway owner. Keep the tag and release unpublished until this check passes. [CLI changes](https://github.com/Keon-Systems/keon-kontinuity-cli/pull/2)

## Unblock in this order

1. **Fix the hosted Gateway deployment.** The owner restores the public MCP endpoint. Confirm that an authenticated test client can initialize and list the memory and curation tools through that endpoint.
2. **Give the writer and reader distinct roles on one isolated project.** The owner provisions two keys and their enrollment rows. Each row has its own actor and a distinct `RoleId`. Both target the same isolated `proj_…` profile. The writer can stage a private record and propose sharing it. The reader can read shared memory in the test project.
3. **Set up a separate owner row with `curation.approve`.** The owner provisions or identifies a third enrollment scoped to the same isolated project. Keep curation approval on this owner row. The writer and reader use their own credentials throughout the test.

The Gateway owner manages issuance and enrollment configuration. Use secure-store references for credentials and keep their values out of the PR, shell history, CI logs, and evidence.

## Verify the hosted handoff

Use the tested v0.2.0 package and separate clean CLI contexts for the writer and reader. Use a synthetic decision containing a unique marker.

1. Confirm that both contexts report the same isolated project and reach the hosted Gateway.
2. Stage the decision with the writer. Confirm that the writer can retrieve its private record and the reader cannot retrieve it.
3. Submit the sharing proposal under the writer’s identity. Review and approve it through the Gateway’s curation disposition using the separate owner enrollment. Record the proposal and approval references and verify the approver identity.
4. Start a fresh reader session. Confirm that its briefing or recall retrieves the same decision as shared memory.
5. Record the verified project, distinct roles, source and shared record references, and the pass result. Publish the verified package after the owner records that evidence.

The local synthetic demo and the platform matrix verify the release artifact independently of the hosted handoff. [Package verification run](https://github.com/Keon-Systems/keon-kontinuity-cli/actions/runs/45049637654)
