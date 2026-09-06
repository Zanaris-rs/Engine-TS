/**
 * client -> server opcodes for friends server
 */
export const enum FriendsClientOpcodes {
    WORLD_CONNECT,
    FRIENDLIST_ADD,
    FRIENDLIST_DEL,
    IGNORELIST_ADD,
    IGNORELIST_DEL,
    PLAYER_LOGIN,
    PLAYER_LOGOUT,
    PLAYER_CHAT_SETMODE,
    PRIVATE_MESSAGE,
    PUBLIC_CHAT_LOG,
    // temporarily in the friend server (it has a constant connection established)
    RELAY_MUTE,
    RELAY_KICK,
    RELAY_SHUTDOWN,
    RELAY_BROADCAST,
    RELAY_TRACK,
    RELAY_RELOAD,
    RELAY_CLEARLOGINS,
    RELAY_CLEARLOGOUTS,
    RELAY_QUEUESCRIPT
}

/**
 * server -> client opcodes for friends server
 */
export const enum FriendsServerOpcodes {
    UPDATE_FRIENDLIST,
    UPDATE_IGNORELIST,
    PRIVATE_MESSAGE,
    // temporarily in the friend server
    RELAY_MUTE,
    RELAY_KICK,
    RELAY_SHUTDOWN,
    RELAY_BROADCAST,
    RELAY_TRACK,
    RELAY_RELOAD,
    RELAY_CLEARLOGINS,
    RELAY_CLEARLOGOUTS,
    RELAY_QUEUESCRIPT
}
