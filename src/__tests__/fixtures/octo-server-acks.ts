/**
 * Frozen success bodies of the real Bot API card endpoints, derived from
 * server source (not from a captured live response):
 *
 * - POST /v1/bot/sendMessage — octo-server `modules/bot_api/send.go`
 *   (`BotSendMessageReq` has no `client_msg_no`; success is
 *   `c.Response(result)`), octo-lib `config/msg.go` (`MsgSendReq` forwards no
 *   `ClientMsgNo`; `MsgSendResp{MessageID int64, ClientMsgNo string,
 *   MessageSeq uint32}` built from the IM reply) and `pkg/wkhttp`
 *   (`Response` = bare `c.JSON(200, data)`). The client's `client_msg_no` is
 *   dropped, so the echoed key is IM-assigned or empty, never ours, and
 *   `message_id` is a bare JSON int64 number that may exceed 2^53.
 * - POST /v1/bot/message/edit — every success path is `c.ResponseOK()`, i.e.
 *   `{"status":200}` with no `message_id` or `card_seq`.
 *
 * The exact IM-assigned `client_msg_no` value was never captured live; the
 * generated values below only model "present, server-owned, not the request".
 */

/** int64 above 2^53 that `Number()` would round. */
export const SERVER_BIG_ID = "9223372036854775001";
export const SERVER_GENERATED_CLIENT_MSG_NO = "8f1d2c3b4a5e46f7a8b9c0d1e2f3a4b50";

/** Raw body text: `message_id` stays an unquoted JSON number, as Go encodes int64. */
export function serverSendAck(messageId: string, clientMsgNo: string = SERVER_GENERATED_CLIENT_MSG_NO, messageSeq = 7): string {
  return `{"message_id":${messageId},"client_msg_no":${JSON.stringify(clientMsgNo)},"message_seq":${messageSeq}}`;
}

export const SERVER_EDIT_ACK = '{"status":200}';
