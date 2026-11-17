package handler

import (
	"net/http"
	"strconv"

	"github.com/gin-gonic/gin"

	"ragflow/internal/common"
)

func chatTaskResponse(c *gin.Context, value interface{}, err error) {
	c.Header("Cache-Control", "private, no-store")
	if err != nil {
		status := http.StatusBadRequest
		if len(err.Error()) >= 10 && err.Error()[:10] == "not_found:" {
			status = http.StatusNotFound
		}
		common.Respond(c, status, common.CodeArgumentError, nil, err.Error())
		return
	}
	common.RespondSuccess(c, value, "success")
}

func (h *ChatSessionHandler) ListChatTasks(c *gin.Context) {
	page, size, err := common.ParsePagination(c.Request.URL.Query())
	if err != nil {
		chatTaskResponse(c, nil, err)
		return
	}
	value, err := h.chatSessionService.ListChatTasks(c.Request.Context(), c.Query("session_id"), c.Query("state"), c.Query("kind"), page, size)
	chatTaskResponse(c, value, err)
}

func (h *ChatSessionHandler) GetChatTask(c *gin.Context) {
	value, err := h.chatSessionService.GetChatTask(c.Request.Context(), c.Param("task_id"))
	chatTaskResponse(c, value, err)
}

func (h *ChatSessionHandler) ChatTaskEvents(c *gin.Context) {
	cursor, err := strconv.ParseInt(c.DefaultQuery("after_seq", "0"), 10, 64)
	if err != nil {
		chatTaskResponse(c, nil, err)
		return
	}
	value, err := h.chatSessionService.ChatTaskEvents(c.Request.Context(), c.Param("task_id"), cursor)
	chatTaskResponse(c, value, err)
}

func (h *ChatSessionHandler) CancelChatTask(c *gin.Context) {
	value, err := h.chatSessionService.CancelChatTask(c.Request.Context(), c.Param("task_id"))
	chatTaskResponse(c, value, err)
}

func (h *ChatSessionHandler) RetryChatTask(c *gin.Context) {
	var request struct {
		Stage    string `json:"stage"`
		Revision int64  `json:"revision"`
	}
	if err := c.ShouldBindJSON(&request); err != nil {
		chatTaskResponse(c, nil, err)
		return
	}
	value, err := h.chatSessionService.RetryChatTask(c.Request.Context(), c.Param("task_id"), request.Stage, request.Revision)
	chatTaskResponse(c, value, err)
}

func (h *ChatSessionHandler) ChatCapabilities(c *gin.Context) {
	value, err := h.chatSessionService.ChatCapabilities(c.Request.Context())
	chatTaskResponse(c, value, err)
}
