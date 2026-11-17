package service

import (
	"encoding/json"
	"errors"
	"strings"

	"ragflow/internal/entity"
)

func chatCredentialKey(key string) bool {
	key = strings.ToLower(key)
	switch key {
	case "token", "authorization", "password", "credential", "credentials":
		return true
	}
	return strings.Contains(key, "api_key") || strings.Contains(key, "apikey") ||
		strings.Contains(key, "secret") || strings.HasSuffix(key, "_token") && key != "max_token"
}

// Copy settings recursively, keeping credentials out of durable task inputs.
func chatTaskSettings(settings map[string]interface{}) entity.JSONMap {
	// Normalize all JSON containers, including named maps and nested slices.
	raw, err := json.Marshal(settings)
	if err != nil {
		return nil
	}
	var normalized map[string]interface{}
	if json.Unmarshal(raw, &normalized) != nil {
		return nil
	}
	return sanitizeChatTaskValue(normalized).(map[string]interface{})
}

func sanitizeChatTaskValue(value interface{}) interface{} {
	switch typed := value.(type) {
	case map[string]interface{}:
		result := entity.JSONMap{}
		for key, value := range typed {
			if chatCredentialKey(key) {
				continue
			}
			result[key] = sanitizeChatTaskValue(value)
		}
		return map[string]interface{}(result)
	case []interface{}:
		values := make([]interface{}, len(typed))
		for i, item := range typed {
			values[i] = sanitizeChatTaskValue(item)
		}
		return values
	default:
		return value
	}
}

func restoreChatCredentials(frozen, current map[string]interface{}) error {
	if frozen == nil && current == nil {
		return nil
	}
	if frozen == nil || current == nil {
		return errModelConfigUnavailable
	}
	return restoreChatCredentialValues(frozen, current)
}

var chatModelIdentityKeys = []string{"id", "model_id", "llm_id", "model_name", "provider", "base_url", "model_type"}

var errChatModelConfigurationChanged = errors.New("chat model configuration changed after task submission")

func restoreChatCredentialValues(frozen, current map[string]interface{}) error {
	for _, key := range chatModelIdentityKeys {
		oldValue, hadOld := frozen[key]
		newValue, hasNew := current[key]
		if hadOld != hasNew || hadOld && oldValue != newValue {
			return errChatModelConfigurationChanged
		}
	}
	for key, value := range current {
		if chatCredentialKey(key) {
			frozen[key] = value
			continue
		}
		if err := restoreChatCredentialValue(frozen[key], value); err != nil {
			return err
		}
	}
	return nil
}

func chatSettingsMap(value interface{}) map[string]interface{} {
	switch typed := value.(type) {
	case map[string]interface{}:
		return typed
	case entity.JSONMap:
		return typed
	default:
		return nil
	}
}

func restoreChatCredentialValue(frozen, current interface{}) error {
	if target := chatSettingsMap(frozen); target != nil {
		source := chatSettingsMap(current)
		if source == nil {
			if len(target) == 0 {
				return nil
			}
			return errChatModelConfigurationChanged
		}
		return restoreChatCredentialValues(target, source)
	}
	target, ok := frozen.([]interface{})
	source, valid := current.([]interface{})
	if ok {
		if !valid || len(target) != len(source) {
			return errChatModelConfigurationChanged
		}
		for i := range target {
			if err := restoreChatCredentialValue(target[i], source[i]); err != nil {
				return err
			}
		}
	}
	return nil
}
