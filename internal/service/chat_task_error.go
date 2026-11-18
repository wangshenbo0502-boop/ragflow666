package service

import (
	"context"
	"errors"
	"fmt"
	"net/http"
	"strings"

	"ragflow/internal/dao"
	"ragflow/internal/entity/models"
	"ragflow/internal/permission"
)

func chatHTTPResultUnknown(status int) bool {
	// A timeout or lost gateway response is not a receipt that generation stopped.
	switch status {
	case http.StatusRequestTimeout, http.StatusBadGateway, http.StatusGatewayTimeout, 520, 524:
		return true
	default:
		return false
	}
}

func chatTaskError(err error) (string, string) {
	switch {
	case errors.Is(err, context.DeadlineExceeded):
		return "deadline_exceeded", "执行期限已耗尽，已保存的结果仍然可用"
	case errors.Is(err, context.Canceled):
		return "cancelled", "执行已停止"
	case errors.Is(err, dao.ErrChatTaskBudget):
		return "budget_exhausted", "调用次数、费用或执行期限已耗尽"
	case errors.Is(err, dao.ErrChatTaskDeadline):
		return "deadline_exceeded", "执行期限已耗尽，已保存的结果仍然可用"
	case errors.Is(err, dao.ErrChatTaskResourceWaitTimeout):
		return "resource_unavailable", "执行资源持续不可用，请稍后重试"
	case errors.Is(err, dao.ErrChatTaskResourceConfig):
		return "resource_config_mismatch", "任务资源配置不一致，请联系管理员"
	case errors.Is(err, dao.ErrChatTaskQuota):
		return "resource_unavailable", "执行资源暂不可用"
	case errors.Is(err, dao.ErrChatTaskLease):
		return "executor_lost", "执行租约已失效"
	case errors.Is(err, dao.ErrAnswerVersion):
		return "revision_conflict", "回答版本已变化，请刷新后重试"
	case errors.Is(err, dao.ErrChatMediaReclaimed):
		return "attachment_unavailable", "引用的媒体已进入清理流程"
	case errors.Is(err, permission.ErrUnauthenticated),
		errors.Is(err, permission.ErrPermissionDenied),
		errors.Is(err, permission.ErrMembershipNotFound),
		errors.Is(err, permission.ErrIdentityMismatch):
		return "forbidden", "执行权限已失效"
	case errors.Is(err, permission.ErrResourceNotFound):
		return "not_found", "任务依赖的资源已不可用"
	case errors.Is(err, errChatModelConfigurationChanged):
		return "provider_identity_changed", "提交后模型服务身份已变化，请重新提交任务"
	case errors.Is(err, models.ErrModelDriverUnavailable):
		return "model_driver_missing", "当前模型服务驱动不可用"
	case errors.Is(err, models.ErrChatMaxOutput):
		return "max_output_validation", "模型输出长度配置超过该模型支持范围"
	case errors.Is(err, errModelConfigUnavailable), errors.Is(err, ErrNoDefaultModel):
		return "unsupported_capability", "当前模型配置不可用"
	case errors.Is(err, errChatMediaTransport), errors.Is(err, errChatMediaResponseRead), errors.Is(err, errChatMediaResponseTooLarge):
		return "upstream_result_unknown", "上游结果尚未确认，暂不能重新生成"
	}
	var stopped *chatUpstreamStoppedError
	if errors.As(err, &stopped) && strings.HasPrefix(stopped.cause, "image_response_") {
		return "invalid_image_response", stopped.message + "。请先核对上游请求记录，再决定是否重试"
	}
	httpStatus := chatUpstreamHTTPStatus(err)
	if chatHTTPResultUnknown(httpStatus) {
		return "upstream_result_unknown", "上游结果尚未确认，暂不能重新生成"
	}
	if httpStatus == 429 {
		return "upstream_rate_limited", "模型服务限流，请稍后重试"
	}
	if httpStatus == 401 || httpStatus == 403 {
		return "upstream_auth_failed", "模型服务授权不可用"
	}
	if httpStatus != 0 {
		return "upstream_unavailable", fmt.Sprintf("模型服务未能完成请求（HTTP %d）", httpStatus)
	}
	// Only protocol codes are exposed; upstream error bodies and URLs stay private.
	messages := map[string]string{
		"invalid_request":             "任务输入无效",
		"invalid_plan":                "模型返回的语音计划格式不完整，未发起语音合成",
		"attachment_unavailable":      "附件不可用",
		"context_budget_exceeded":     "当前问题和附件超过模型上下文，请减少附件或选择更大上下文的模型",
		"budget_exceeded":             "无法在当前费用预算内执行，请核对模型价格和预算",
		"unsupported_capability":      "没有符合要求的模型能力",
		"vision_model_required":       "当前模型配置未启用图片理解，请核对模型的视觉能力配置；这不代表模型本身不支持识图",
		"route_no_eligible_candidate": "当前没有可执行的模型候选，请稍后重试",
		"provider_identity_changed":   "提交后模型服务身份已变化，请重新提交任务",
		"forbidden":                   "执行权限已失效",
		"not_found":                   "任务或会话已不可用",
		"revision_conflict":           "回答版本已变化，请刷新后重试",
		"idempotency_conflict":        "请求标识已用于其他内容",
		"persistence_failed":          "生成结果未能保存，已保存的结果仍然可用",
		"checkpoint_incomplete":       "恢复检查点不完整，已停止自动执行",
		"stage_incomplete":            "仍有媒体阶段未完成，可单独重试",
		"queue_unavailable":           "任务队列暂不可用",
		"upstream_result_unknown":     "上游结果尚未确认，暂不能重新生成",
	}
	if err != nil {
		if code, _, ok := strings.Cut(err.Error(), ":"); ok {
			if message, exists := messages[code]; exists {
				return code, message
			}
		}
	}
	return "upstream_unavailable", "生成未完成，已保存的结果仍然可用"
}

func chatUpstreamHTTPStatus(err error) int {
	var status *models.APIStatusError
	if errors.As(err, &status) {
		return status.Status
	}
	return 0
}
