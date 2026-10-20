import { Agent } from "gemi/ai";
import { provider } from "./config-ai";

export const supportAgent = Agent.create({ name: "support", provider });
