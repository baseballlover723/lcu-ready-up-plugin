import LcuPlugin from 'lcu-plugin';
import axios from 'axios';

const CURRENT_SUMMONER_ENDPOINT = 'lol-summoner/v1/current-summoner';
const PARTY_ENDPOINT = 'lol-lobby/v1/parties/player';
const PARTY_ACTIVE_ENDPOINT = 'lol-lobby/v2/party-active';
const LOBBY_ENDPOINT = 'lol-lobby/v2/lobby';
const MEMBERS_ENDPOINT = 'lol-lobby/v2/lobby/members';
const LOBBY_MATCHMAKING_SEARCH_ENDPOINT = 'lol-lobby/v2/lobby/matchmaking/search';
const CONVERSATIONS_EVENT = 'OnJsonApiEvent_lol-chat_v1_conversations';
const LOBBY_EVENT = 'OnJsonApiEvent_lol-lobby_v2_comms';
const MATCHMAKING_EVENT = 'OnJsonApiEvent_lol-matchmaking_v1_search';
const SUMMONER_ENDPOINT = 'lol-summoner/v2/summoners/puuid/';

const PARTY_RESTRICTION_QUEUES = new Set([490]); // QuickPlay

const READY_LIST_HEADER = ".\nParty ready status";
const MESSAGE_RETRY_PERIOD = 200;
const NOT_SELF_MIN_DELAY = 750; // ms
const READY_EMOJI = '✅';
const NOT_READY_EMOJI = '❌';

// TODO mode switch doesn't clear ready status
export default class ReadyUpLcuPlugin extends LcuPlugin {
  onConnect(clientData) {
    axios.defaults.baseURL = `${clientData.protocol}://${clientData.address}:${clientData.port}`;
    axios.defaults.auth = {username: clientData.username, password: clientData.password};

    this.partyMembers = {};
    this.statusRequesterResponded = false;
    this.sentMessages = new Set();

    return this.createPromise((resolve, reject) => {
      this.getCurrentSummoner().then((summonerId) => {
        const finish = () => {
          this.subscribeEvent(MATCHMAKING_EVENT, this.handleMatchmakingStart);
          this.subscribeEvent(LOBBY_EVENT, this.handlePartyMemberChange(summonerId));
          this.subscribeEvent(CONVERSATIONS_EVENT, this.handleLobbyChat(summonerId));
          this.log('is ready');
          resolve();
        };
        this.isPartyActive().then((isPartyActive) => {
          if (isPartyActive.data) {
            this.getLobbyMembers().then((resp) => {
              for (const summoner of resp.data) {
                this.partyMembers[summoner.summonerId] = false;
              }
              finish();
            });
          } else {
            finish();
          }
        });
      }).catch((error) => {
        reject(error);
      });
    });
  }

  getCurrentSummoner(retriesLeft = 20) {
    return this.createPromise((resolve, reject) => {
      this.getCurrentSummonerHelper(retriesLeft, resolve, reject);
    });
  }

  getCurrentSummonerHelper(retriesLeft, resolve, reject) {
    axios.get(CURRENT_SUMMONER_ENDPOINT).then((resp) => {
      resolve(resp.data.summonerId);
    }).catch((error) => {
      if ((error.code !== 'ECONNREFUSED' && error?.response?.status >= 500) || retriesLeft <= 0) {
        this.log('error in getting current summoner', error);
        reject(error);
      }
      setTimeout(() => {
        this.getCurrentSummonerHelper(retriesLeft - 1, resolve, reject);
      }, 1000);
    });
  }

  sendMessage(chatUrl, message, retriesLeft = 2) {
    axios.post(chatUrl, {
      body: message,
    }).then((response) => {
      this.sentMessages.add(response.data.id);
    }).catch((error) => {
      if (retriesLeft > 0) {
        this.log(`send message error, retrying (${retriesLeft - 1} retries left)`);
        setTimeout(this.sendMessage, MESSAGE_RETRY_PERIOD, chatUrl, message, retriesLeft - 1);
      } else {
        this.error('error: ', error);
      }
    });
  }

  async getSummonerInfo(puuid) {
    return axios.get(SUMMONER_ENDPOINT + puuid).catch((error) => {
      this.error('error: ', error);
    });
  }

  async isPartyActive() {
    return axios.get(PARTY_ACTIVE_ENDPOINT);
  }

  async startQueue() {
    return axios.post(LOBBY_MATCHMAKING_SEARCH_ENDPOINT)
      .catch((error) => this.error(error));
  }

  async getLobbyMembers() {
    return axios.get(MEMBERS_ENDPOINT);
  }

  amLeader(currentSummonerId, players) {
    return players.data.some((player) => currentSummonerId === player.summonerId && player.isLeader);
  }

  getLobby() {
    return axios.get(LOBBY_ENDPOINT);
  }

  getParty() {
    return axios.get(PARTY_ENDPOINT);
  }

  handleMatchmakingStart(event) {
    // this.log(JSON.stringify(event, null, 2));
    if (event.eventType !== 'Create') {
      return;
    }

    if (event.data.errors.length > 0) {
      this.log("Couldn't start queue", event.data.errors);
      return;
    }

    this.log('Queue started, clearing readyCheck');
    for (const key in this.partyMembers) {
      this.partyMembers[key] = false;
    }
  }

  handlePartyMemberChange(currentSummonerId) {
    return async (event) => {
      // this.log("event", JSON.stringify(event, null, 2));
      const partySummonerIds = new Set(Object.entries(event.data.players).map(([_, value]) => value.summonerId.toString()));

      for (const summonerId in this.partyMembers) {
        if (!partySummonerIds.has(summonerId)) {
          delete this.partyMembers[summonerId];
        }
      }

      partySummonerIds.forEach((summonerId) => {
        if (!this.partyMembers[summonerId]) {
          this.partyMembers[summonerId] = false;
        }
      });

      await this.tryToStartQueue(currentSummonerId);
    };
  }

  handleLobbyChat(currentSummonerId) {
    return async (event) => {
      if (event.eventType !== 'Create') {
        return;
      }
      // this.log('received party chat: ', event);
      if (event.data.type !== 'groupchat') {
        return;
      }

      if (this.sentMessages.has(event.data.id)) {
        this.log(`ignoring message ${event.data.id} because we sent it`);
        this.sentMessages.delete(event.data.id);
        return;
      }
      // this.log('received party chat: ', event);
      if (event.data.body.startsWith(READY_LIST_HEADER)) {
        this.statusRequesterResponded = true;
      }
      if (!/(^r$)|(^ready$)|(^nr$)|(^not ready$)|(^\/list\s+ready$)/i.test(event.data.body)) {
        // this.log(`startQueuePlugin ignoring message "${event.data.body}" because it didn't match the regex`);
        return;
      }

      if (event.data.body.toLowerCase().startsWith("/list")) {
        const chatUrl = event.uri.substring(0, event.uri.lastIndexOf('/'));
        await this.listReadyToChat(currentSummonerId, chatUrl, event.data.fromSummonerId);
        return;
      } else if (event.data.body.toLowerCase().startsWith('r')) {
        this.partyMembers[event.data.fromSummonerId] = true;
      } else {
        this.partyMembers[event.data.fromSummonerId] = false;
        return;
      }

      await this.tryToStartQueue(currentSummonerId);
    };
  }

  async tryToStartQueue(currentSummonerId) {
    if (!(await this.isPartyActive()).data) {
      this.log('Ignoring because party is not active');
      return;
    }

    const players = await this.getLobbyMembers();

    if (players.data.some((player) => !this.partyMembers[player.summonerId])) {
      this.log('Not all players are ready');
      return;
    }

    if (!this.amLeader(currentSummonerId, players)) {
      this.log('Ignoring since I am not party leader');
      return;
    }

    const lobby = await this.getLobby();
    if (PARTY_RESTRICTION_QUEUES.has(lobby.data.gameConfig.queueId)) {
      const party = await this.getParty();
      if (party.data.currentParty.eligibilityRestrictions.length !== 0) {
        this.log("Can't start queue");
        return;
      }
    } else if (!lobby.data.canStartActivity) {
      this.log("Can't start queue");
      return;
    }

    await this.startQueue();
  }

  // Multi posts after a delay if a non plugin user uses it (chat has too big latency to ensure that only 1 message gets printed (~425 ms to detect message sent))
  async listReadyToChat(currentSummonerId, chatUrl, requestingSummonerId) {
    if (currentSummonerId !== requestingSummonerId) {
      this.statusRequesterResponded = false;
      await this.sleep(NOT_SELF_MIN_DELAY);
      if (this.statusRequesterResponded) {
        this.statusRequesterResponded = false;
        this.log('Status requester responded themselves, so no need for us to respond as well');
        return;
      }
    }
    const players = await this.getLobbyMembers();

    const nameMap = await Promise.all(players.data.map((player) => this.getSummonerInfo(player.puuid)))
      .then((resps) => {
        return resps.reduce((map, resp) => {
          map[resp.data.summonerId] = `${resp.data.gameName}#${resp.data.tagLine}`;
          return map;
        }, {});
      });

    const [playerReadyStatuses, readyPlayers, totalPlayers] = players.data.reduce(([readyStatuses, readyPlayers, totalPlayers], player) => {
      const isReady = this.partyMembers[player.summonerId];
      readyStatuses.push(`${nameMap[player.summonerId]}: ${isReady ? READY_EMOJI : NOT_READY_EMOJI}`);
      return [readyStatuses, readyPlayers + (isReady ? 1 : 0), totalPlayers + 1];
    }, [[], 0, 0]);

    const readyStatusStr = [`${READY_LIST_HEADER} (${readyPlayers} / ${totalPlayers}):`].concat(playerReadyStatuses).join("\n");
    this.sendMessage(chatUrl, readyStatusStr);
  }
}
