import { Module } from '@nestjs/common';
import { DeviceModule } from '../device/device.module.js';
import { LlmModule } from '../llm/llm.module.js';
import { ProjectsModule } from '../projects/projects.module.js';
import { RulesModule } from '../rules/rules.module.js';
import { SessionsModule } from '../sessions/sessions.module.js';
import { StatsModule } from '../stats/stats.module.js';
import { McpAuthGuard } from './mcp-auth.guard.js';
import { McpAuthService } from './mcp-auth.service.js';
import { McpToolRegistry } from './mcp-tool-registry.js';
import { McpController } from './mcp.controller.js';
import { McpService } from './mcp.service.js';
import {
  GetMemberProfileTool,
  GetOverviewTool,
  ListMembersTool,
  ListProjectsTool,
} from './tools/project-tools.js';
import {
  GetMyAiResultsTool,
  GetRuleTool,
  ListRulesTool,
} from './tools/rule-and-ai-tools.js';
import {
  GetFindingsTool,
  GetSessionTool,
  SearchSessionsTool,
} from './tools/session-tools.js';
import { WhoamiTool } from './tools/whoami.tool.js';
import {
  AddSessionNoteTool,
  DraftRuleTool,
  SaveRuleTool,
  SetRuleEnabledTool,
  TestRuleTool,
} from './tools/write-tools.js';

/**
 * Endpoint MCP `/api/v1/mcp` (M6.3), các tool đọc (M6.15), tool ghi cho leader và prompt (M6.16). Thêm tool mới: viết lớp kế thừa `BaseMcpTool`
 * trong `tools/`, khai báo provider ở đây (tool tự đăng ký vào `McpToolRegistry`). Xem README.md.
 * Chỉ import dịch vụ đã export của `projects`, `sessions`, `stats`, `rules`, `llm`; không sửa code của họ.
 */
@Module({
  imports: [
    DeviceModule,
    ProjectsModule,
    SessionsModule,
    StatsModule,
    RulesModule,
    LlmModule,
  ],
  controllers: [McpController],
  providers: [
    McpAuthService,
    McpAuthGuard,
    McpToolRegistry,
    McpService,
    WhoamiTool,
    ListProjectsTool,
    ListMembersTool,
    GetOverviewTool,
    GetMemberProfileTool,
    SearchSessionsTool,
    GetSessionTool,
    GetFindingsTool,
    ListRulesTool,
    GetRuleTool,
    GetMyAiResultsTool,
    DraftRuleTool,
    TestRuleTool,
    SaveRuleTool,
    SetRuleEnabledTool,
    AddSessionNoteTool,
  ],
})
export class McpModule {}
