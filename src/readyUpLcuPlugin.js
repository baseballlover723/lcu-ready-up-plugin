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

const PARTY_RESTRICTION_QUEUES = new Set([490]); // QuickPlay

export default class ReadyUpLcuPlugin extends LcuPlugin {
  onConnect(clientData) {
    axios.defaults.baseURL = `${clientData.protocol}://${clientData.address}:${clientData.port}`;
    axios.defaults.auth = {username: clientData.username, password: clientData.password};

    this.partyMembers = {};

    return this.createPromise((resolve, reject) => {
      this.getCurrentSummoner().then((summonerId) => {
        const finish = () => {
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
      this.log('partyMembers: ', this.partyMembers);
      this.log('received party chat: ', event);
      if (!/(^r$)|(^ready$)|(^nr$)|(^not ready$)/i.test(event.data.body)) {
        // this.log(`startQueuePlugin ignoring message "${event.data.body}" because it didn't match the regex`);
        return;
      }

      if (event.data.body.toLowerCase().startsWith('r')) {
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
    for (const key in this.partyMembers) {
      this.partyMembers[key] = false;
    }
  }
}
