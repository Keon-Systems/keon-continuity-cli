# Hosted handoff release gate for v0.2.0

The hosted handoff passed on November 28, 2026, on Gateway revision `keon-mcp-gateway--0000054` in the isolated profile `proj_cli_v020_handoff`. Distinct writer, reader, and owner enrollments performed the test. The writer recalled the private shard, the reader saw zero matches before approval, and the owner approved the writer's proposal. A fresh reader then recalled the derived shared shard. The two previous reader and owner test keys were rejected as revoked.

| Evidence | Reference |
| --- | --- |
| Private source shard | `87a9d790a1a4de0238b139600ce0b0d11598bc769195100636666f159c1350cd` |
| Writer proposal | `d8acd61d1f815c0d0c7c16660ee02ac9a929cfa9458fd5cd06a8e5404d25455e` |
| Owner disposition | `258e3c73638b115acd00ddd3bf1dfa356b682032016d022c1af77afc212e1d47` |
| Derived shared shard | `57f10fb72af77877651da20984cd66eec7ab19d38f9404fda791dc4333f0ee4a` |
| Reader recall event | `bce37dff9709cee6dea4dce9d6372064ddf2d678988c87ba8d358b0c1191d9a8` |

## Prepare a future verification run

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
