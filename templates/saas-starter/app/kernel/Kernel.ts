import { Kernel } from "gemi/kernel";

import auth from "../config/auth";
import filesystem from "../config/filesystem";
import log from "../config/log";
import mail from "../config/mail";
import middleware from "../config/middleware";
import queue from "../config/queue";
import redis from "../config/redis";
import route from "../config/route";
import schedule from "../config/schedule";
import translation from "../config/translation";

import AppServiceProvider from "../providers/AppServiceProvider";

export default class extends Kernel {
  config = {
    auth,
    filesystem,
    log,
    mail,
    middleware,
    queue,
    redis,
    route,
    schedule,
    translation,
  };

  providers = [AppServiceProvider];
}
