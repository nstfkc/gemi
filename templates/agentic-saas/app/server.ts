import { Server } from "gemi/server";
import Kernel from "./kernel/Kernel";

const server = new Server({ kernel: Kernel });

server.start();
