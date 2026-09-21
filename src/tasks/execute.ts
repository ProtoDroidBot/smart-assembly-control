import { executeAssemblyTask } from "./assembly.ts";
import { executeIndustryTask } from "./industry.ts";
import { executeIndustryBlueprintTask } from "./industry-blueprint.ts";
import { executeInfrastructureTask } from "./infrastructure.ts";
import { executeStorageTask } from "./storage.ts";
import { executeInventoryListenerTask, executeQueueDelayTask } from "./listener.ts";
import { executeRemoteScanTask } from "./scanning.ts";
import type { TaskDraft, TaskExecutionContext } from "./types.ts";

export function executeTask(task: TaskDraft, context: TaskExecutionContext) {
  context.assertCurrent();
  switch (task.operation.kind) {
    case "assembly-state": return executeAssemblyTask(task, context);
    case "storage-transfer": return executeStorageTask(task, context);
    case "industry-start":
    case "industry-transfer": return executeIndustryTask(task, context);
    case "industry-blueprint":
    case "industry-empty": return executeIndustryBlueprintTask(task, context);
    case "gate-link":
    case "gate-unlink":
    case "energy-connect":
    case "energy-disconnect": return executeInfrastructureTask(task, context);
    case "remote-scan": return executeRemoteScanTask(task, context);
    case "inventory-listener": return executeInventoryListenerTask(task, context);
    case "queue-delay": return executeQueueDelayTask(task, context);
    case "queue-timeout": throw new Error("Overall queue timers are handled by the task queue.");
    case "queue-repeat": throw new Error("Queue repeat controls are handled by the task queue.");
  }
}
