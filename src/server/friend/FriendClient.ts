import { ChatModePrivate } from '#/engine/entity/ChatModes.js';
import { FriendsClientOpcodes } from '#/server/friend/FriendOpcodes.js';
import InternalClient from '#/server/InternalClient.js';
import Environment from '#/util/Environment.js';
import { toBase37 } from '#/util/JString.js';

export class FriendClient extends InternalClient {
    nodeId: number = 0;
    profile: string;

    constructor(nodeId: number) {
        super(Environment.friend.host, Environment.friend.port);

        this.nodeId = nodeId;
        this.profile = Environment.node.profile;
    }

    public async worldConnect() {
        await this.connect();

        if (!this.ws || !this.wsr || !this.wsr.checkIfWsLive()) {
            return;
        }

        this.ws.send(
            JSON.stringify({
                type: FriendsClientOpcodes.WORLD_CONNECT,
                world: this.nodeId,
                profile: this.profile
            })
        );
    }

    public async playerLogin(username: string, privateChat: number, staffLvl: number) {
        await this.connect();

        if (!this.ws || !this.wsr || !this.wsr.checkIfWsLive()) {
            return;
        }

        this.ws.send(
            JSON.stringify({
                type: FriendsClientOpcodes.PLAYER_LOGIN,
                world: this.nodeId,
                username37: toBase37(username).toString(),
                privateChat,
                staffLvl
            })
        );
    }

    public async playerLogout(username: string) {
        await this.connect();

        if (!this.ws || !this.wsr || !this.wsr.checkIfWsLive()) {
            return;
        }

        this.ws.send(
            JSON.stringify({
                type: FriendsClientOpcodes.PLAYER_LOGOUT,
                world: this.nodeId,
                username37: toBase37(username).toString()
            })
        );
    }

    public async playerFriendslistAdd(username: string, target: bigint) {
        await this.connect();

        if (!this.ws || !this.wsr || !this.wsr.checkIfWsLive()) {
            return;
        }

        this.ws.send(
            JSON.stringify({
                type: FriendsClientOpcodes.FRIENDLIST_ADD,
                world: this.nodeId,
                username37: toBase37(username).toString(),
                targetUsername37: target.toString()
            })
        );
    }

    public async playerFriendslistRemove(username: string, target: bigint) {
        await this.connect();

        if (!this.ws || !this.wsr || !this.wsr.checkIfWsLive()) {
            return;
        }

        this.ws.send(
            JSON.stringify({
                type: FriendsClientOpcodes.FRIENDLIST_DEL,
                world: this.nodeId,
                username37: toBase37(username).toString(),
                targetUsername37: target.toString()
            })
        );
    }

    public async playerIgnorelistAdd(username: string, target: bigint) {
        await this.connect();

        if (!this.ws || !this.wsr || !this.wsr.checkIfWsLive()) {
            return;
        }

        this.ws.send(
            JSON.stringify({
                type: FriendsClientOpcodes.IGNORELIST_ADD,
                world: this.nodeId,
                username37: toBase37(username).toString(),
                targetUsername37: target.toString()
            })
        );
    }

    public async playerIgnorelistRemove(username: string, target: bigint) {
        await this.connect();

        if (!this.ws || !this.wsr || !this.wsr.checkIfWsLive()) {
            return;
        }

        this.ws.send(
            JSON.stringify({
                type: FriendsClientOpcodes.IGNORELIST_DEL,
                world: this.nodeId,
                username37: toBase37(username).toString(),
                targetUsername37: target.toString()
            })
        );
    }

    public async playerChatSetMode(username: string, privateChatMode: ChatModePrivate) {
        await this.connect();

        if (!this.ws || !this.wsr || !this.wsr.checkIfWsLive()) {
            return;
        }

        this.ws.send(
            JSON.stringify({
                type: FriendsClientOpcodes.PLAYER_CHAT_SETMODE,
                world: this.nodeId,
                username37: toBase37(username).toString(),
                privateChat: privateChatMode
            })
        );
    }

    public async privateMessage(username: string, staffLvl: number, pmId: number, target: bigint, chat: string, coord: number) {
        await this.connect();

        if (!this.ws || !this.wsr || !this.wsr.checkIfWsLive()) {
            return;
        }

        this.ws.send(
            JSON.stringify({
                type: FriendsClientOpcodes.PRIVATE_MESSAGE,
                world: this.nodeId,
                profile: this.profile,
                nodeTime: Date.now(),
                username37: toBase37(username).toString(),
                targetUsername37: target.toString(),
                staffLvl,
                pmId,
                chat,
                coord
            })
        );
    }

    async publicMessage(session_uuid: string, coord: number, chat: string) {
        await this.connect();

        if (!this.ws || !this.wsr || !this.wsr.checkIfWsLive()) {
            return;
        }

        this.ws.send(
            JSON.stringify({
                type: FriendsClientOpcodes.PUBLIC_CHAT_LOG,
                nodeId: this.nodeId,
                profile: this.profile,
                nodeTime: Date.now(),
                session_uuid,
                coord,
                chat
            })
        );
    }
}
