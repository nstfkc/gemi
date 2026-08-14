import { Kernel } from "gemi/kernel";

import auth from "../config/auth";
import database from "../config/database";
import features from "../config/features";
import filesystem from "../config/filesystem";
import log from "../config/log";
import mail from "../config/mail";
import middleware from "../config/middleware";
import queue from "../config/queue";
import redis from "../config/redis";
import route from "../config/route";
import schedule from "../config/schedule";
import translation from "../config/translation";

import * as generated from "../models/generated";
import * as models from "../models";

import AppServiceProvider from "../providers/AppServiceProvider";

export default class extends Kernel {
  // The generated bases, then the classes written over them — later wins, so
  // each subclass takes the name its base was holding. `boot()` registers them
  // and then checks that no policied class lost its name to something else,
  // which is the mistake that would otherwise show up as an `include` quietly
  // returning rows nobody was allowed to see.
  models = [generated, models];

  config = {
    auth,
    database,
    features,
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

  // The app's own singletons. Each is constructed during the synchronous boot
  // phase and its `boot()` awaited during the asynchronous one, in this order —
  // so a service whose `boot()` needs another goes after it. Inject one with a
  // constructor default: `constructor(private billing = Billing.inject()) {}`.
  services = [];
}
