// The services `docs/ai-agent-context.md`'s controller injects.
import { Service } from "gemi/support";

export class PageEditor extends Service {
  static token = "pageEditor";

  async edit(pageId: string, instruction: string) {
    return `${pageId}: ${instruction}`;
  }
}

export class Pictures extends Service {
  static token = "pictures";

  async draw(pageId: string, prompt: string) {
    return { attachmentId: `${pageId}:${prompt}` };
  }
}
