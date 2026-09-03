import { Kernel } from "gemi/kernel";

import auth from "../config/auth";
import database from "../config/database";
import middleware from "../config/middleware";
import queue from "../config/queue";
import redis from "../config/redis";
import route from "../config/route";
import schedule from "../config/schedule";

import * as generated from "../models/generated";
import * as models from "../models";

import AppServiceProvider from "../providers/AppServiceProvider";

export default class extends Kernel {
  // The generated bases, then the classes written over them — later wins, so
  // each subclass takes the name its base was holding.
  models = [generated, models];

  config = {
    auth,
    database,
    middleware,
    queue,
    redis,
    route,
    schedule,
  };

  providers = [AppServiceProvider];

  services = [];
}
