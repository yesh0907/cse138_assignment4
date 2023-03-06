import { ADDRESS } from "@/config";
import ioClient from "@/io/client/index.client";
import { broadcast } from "@/io/index.io";
import ioServer from "@/io/server/index.server";
import viewModel from "@/models/view.model";
import { logger } from "@/utils/logger";
import { Mutex } from "async-mutex";
import axios from "axios";
import clockService from "@/services/clock.service";
import kvsService from "@/services/kvs.service";
import ReplicationService from "@/services/replication.service";

class ViewService {
  public viewObject = viewModel;
  public mutex = new Mutex();

  constructor() {
    this.viewObject.view = [];
  }

  public async getView(): Promise<{ view: string[] }> {
    let ret: { view: string[] };
    await this.mutex.runExclusive(async () => {
      ret = this.viewObject;
    });
    return ret;
  }

  public async setView(incoming: string[], sender = "client"): Promise<void> {
    let oldList = [];
    await this.mutex.runExclusive(async () => {
      // Fetch OldList
      oldList = this.viewObject.view;
    });

    await this.updateView(incoming); // Update View
    const vc = clockService.getVectorClock();
    incoming.forEach(replica => vc.addClock(replica));

    if (oldList.length === 0) {
      // Uninitialized
      // was the view change sent by another replica?
      if (sender === "client") {
        // forward view change to all other replicas via HTTP
        await this.sendViewChange(
          incoming.filter(replica => replica !== ADDRESS),
          incoming,
        );
        // get IO Server to start listening for connections
        ioServer.listen();
      } else {
        // connect to sender's IO Server
        ioClient.connect(`http://${sender}`);
      }
      const replication = new ReplicationService();
      replication.begin();
    } else {
      // Already Initialized
      if (sender === "client") {
        const containsAll = (arr1, arr2) => arr2.every(arr2Item => arr1.includes(arr2Item));
        const sameMembers = (arr1, arr2) => containsAll(arr1, arr2) && containsAll(arr2, arr1);
        const missing = oldList.filter(n => !incoming.includes(n));
        const extra = incoming.filter(n => !oldList.includes(n));

        // view has changed
        if (!sameMembers(oldList, incoming)) {
          let ioServerKilled = false;
          const ioServerIP = ioClient.getIP();
          // figure out if replica running IO server has been killed or not
          if (!ioServer.isListening() && ioClient.isConnected()) {
            // this replica is not running IO Server
            if (missing.includes(ioServerIP)) {
              ioServerKilled = true;
            }
          }
          if (missing.length > 0) {
            // some replicas been removed from view
            broadcast("viewchange:kill", missing);
          }
          if (ioServerKilled) {
            // IO Server has been killed
            // 1. disconnect from current IO Server
            if (ioClient.isConnected()) {
              ioClient.disconnect();
            }
            // 2. this replica becomes IO server
            ioServer.listen();
            // 3. forward view change to all other replicas via HTTP
            await this.sendViewChange(
              incoming.filter(replica => replica !== ADDRESS),
              incoming,
            );
          } else {
            if (extra.length > 0) {
              // new replicas added to view
              await this.sendViewChange(extra, incoming, ioServerIP);
            }
            // update existing replica views
            broadcast("viewchange:update", incoming);
          }
        }
      } else {
        // Disconnect from previous IO Server
        if (ioClient.isConnected()) {
          ioClient.disconnect();
        }
        // Connect to sender's IO Server
        ioClient.connect(`http://${sender}`);
      }
    }
  }

  public async updateView(incoming: string[]): Promise<void> {
    await this.mutex.runExclusive(async () => {
      this.viewObject.view = [];
      incoming.forEach(element => {
        this.viewObject.view.push(element);
      });
    });
  }

  public async deleteView(): Promise<void> {
    await this.mutex.runExclusive(async () => {
      await kvsService.clearKvs();
      this.viewObject.view = [];
    });
  }

  public async sendViewChange(replicas: string[], view: string[], sender = ADDRESS): Promise<void> {
    const addresses = replicas.map(replicaAddress => `http://${replicaAddress}/kvs/admin/view`);
    try {
      const reqBody = {
        view,
        sender,
      };
      const reqHeaders = { headers: { "Content-Type": "application/json" } };
      const reqPromises = addresses.map(address => axios.put(address, reqBody, { ...reqHeaders, timeout: 10000 }));

      await Promise.all(reqPromises);
    } catch (error) {
      logger.error("viewService:sendViewChange - " + error);
    }
  }

  public async checkReplicas(err, responses) {
    logger.info(`checkReplicas - ${JSON.stringify(responses)}`);
    if (err) {
      logger.info("viewService:checkReplicas - " + err);
      const view = await this.getView();
      const viewReplicas = view.view;
      const missingReplicas = viewReplicas.filter(replica => !responses.includes(replica));
      if (missingReplicas.length > 0) {
        logger.error("viewService:checkReplicas - " + missingReplicas + " missing");
      } else {
        logger.info("viewService:checkReplicas - all replicas are acked write");
      }
    }
  }

  public async changeIOServer(): Promise<void> {
    const view = await this.getView();
    const viewReplicas = view.view;
    // IO Server is down but still in view, so connect to this replica's IO server
    // 1. disconnect from current IO Server
    if (ioClient.isConnected()) {
      ioClient.disconnect();
    }
    // 2. this replica becomes IO server
    ioServer.listen();
    // 3. forward view change to all other replicas via HTTP
    await this.sendViewChange(
      viewReplicas.filter(replica => replica !== ADDRESS),
      viewReplicas,
    );
  }
}

const myService = new ViewService();
export default myService;