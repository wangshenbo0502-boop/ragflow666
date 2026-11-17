package service

import (
	"errors"
	"testing"
)

func TestRestoreChatCredentialsRequiresMatchingModelIdentity(t *testing.T) {
	frozen := map[string]interface{}{
		"providers": []interface{}{
			map[string]interface{}{"model_name": "alpha", "api_key": "frozen-alpha"},
			map[string]interface{}{"model_name": "beta", "api_key": "frozen-beta"},
		},
	}
	current := map[string]interface{}{
		"providers": []interface{}{
			map[string]interface{}{"model_name": "beta", "api_key": "current-beta"},
			map[string]interface{}{"model_name": "alpha", "api_key": "current-alpha"},
		},
	}
	if err := restoreChatCredentials(frozen, current); !errors.Is(err, errChatModelConfigurationChanged) {
		t.Fatalf("reordered provider configuration must fail closed with its cause: %v", err)
	}
	providers := frozen["providers"].([]interface{})
	if providers[0].(map[string]interface{})["api_key"] != "frozen-alpha" {
		t.Fatal("credentials were restored to the wrong provider")
	}
}

func TestRestoreChatCredentialsAllowsSecretRotationForSameModel(t *testing.T) {
	frozen := map[string]interface{}{
		"providers": []interface{}{
			map[string]interface{}{"model_name": "alpha", "api_key": "frozen-alpha"},
		},
	}
	current := map[string]interface{}{
		"providers": []interface{}{
			map[string]interface{}{"model_name": "alpha", "api_key": "rotated-alpha"},
		},
	}
	if err := restoreChatCredentials(frozen, current); err != nil {
		t.Fatal(err)
	}
	provider := frozen["providers"].([]interface{})[0].(map[string]interface{})
	if provider["api_key"] != "rotated-alpha" {
		t.Fatalf("credential = %v, want rotated secret", provider["api_key"])
	}
}

func TestRestoreChatCredentialsRejectsChangedConfiguration(t *testing.T) {
	frozen := map[string]interface{}{"model_name": "alpha", "model_type": "chat"}
	current := map[string]interface{}{"model_name": "alpha", "model_type": "image2text"}
	if err := restoreChatCredentials(frozen, current); !errors.Is(err, errChatModelConfigurationChanged) {
		t.Fatalf("changed model capabilities must fail closed with their cause: %v", err)
	}
}

func TestRestoreChatCredentialsRejectsChangedContainer(t *testing.T) {
	for _, current := range []map[string]interface{}{
		{"providers": []interface{}{}},
		{"providers": []interface{}{"unavailable"}},
	} {
		frozen := map[string]interface{}{
			"providers": []interface{}{
				map[string]interface{}{"model_name": "alpha"},
			},
		}
		if err := restoreChatCredentials(frozen, current); !errors.Is(err, errChatModelConfigurationChanged) {
			t.Fatalf("changed credential container lost its cause: %v", err)
		}
	}
}

func TestRestoreChatCredentialsRejectsUnavailableConfiguration(t *testing.T) {
	for _, settings := range []struct {
		frozen, current map[string]interface{}
	}{
		{frozen: map[string]interface{}{"model_name": "alpha"}},
		{current: map[string]interface{}{"model_name": "alpha"}},
	} {
		err := restoreChatCredentials(settings.frozen, settings.current)
		if !errors.Is(err, errModelConfigUnavailable) {
			t.Fatalf("missing model configuration lost its cause: %v", err)
		}
		code, _ := chatTaskError(err)
		if code != "unsupported_capability" {
			t.Fatalf("missing configuration classified as %s", code)
		}
	}
	if err := restoreChatCredentials(nil, nil); err != nil {
		t.Fatal(err)
	}
}
