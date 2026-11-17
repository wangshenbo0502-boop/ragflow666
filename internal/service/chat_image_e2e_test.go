//go:build e2e

package service

import (
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"image"
	"image/color"
	"image/png"
	"io"
	"net/http"
	"os"
	"reflect"
	"testing"

	"ragflow/internal/entity"
)

type chatImageObservation struct {
	Path   string   `json:"path"`
	Size   string   `json:"size"`
	Hashes []string `json:"image_sha256"`
}

func TestChatImageRealSelectedParentAndReferences(t *testing.T) {
	e := chatMediaE2E(t)
	db := chatFaultDatabase(t)
	control := os.Getenv("RAGFLOW_TEST_CHAT_IMAGE_CONTROL")
	before := e.mediaControl(control, 0)
	chatID, sessionID := e.newMediaSession("Real selected older image with two references")
	generate := func(question, parent string, files []map[string]any) entity.ChatMediaAsset {
		t.Helper()
		body := map[string]any{"chat_id": chatID, "session_id": sessionID, "mode": "image",
			"stream": false, "question": question}
		if parent != "" {
			body["edit_asset_id"] = parent
		}
		if len(files) > 0 {
			body["files"] = files
		}
		var admission struct {
			TaskID string `json:"task_id"`
		}
		e.request(http.MethodPost, "/chat/completions", body, &admission)
		detail := e.waitTask(admission.TaskID)
		if detail.Task.State != "succeeded" {
			t.Fatalf("real image task failed: %s/%s", detail.Task.State, detail.Task.ErrorCode)
		}
		var asset entity.ChatMediaAsset
		if err := db.Take(&asset, "task_id = ? AND kind = ?", detail.Task.ID, "image").Error; err != nil ||
			asset.State != "committed" || asset.Width < 1 || asset.Height < 1 || asset.ParentID != parent {
			t.Fatalf("incorrect real image dimensions/parent: %dx%d parent=%s expected=%s",
				asset.Width, asset.Height, asset.ParentID, parent)
		}
		var snapshot entity.ChatTask
		if err := db.Take(&snapshot, "id = ?", detail.Task.ID).Error; err != nil {
			t.Fatal(err)
		}
		var input chatTaskInput
		if err := json.Unmarshal([]byte(snapshot.Input), &input); err != nil || parent != "" && input.ParentID != parent {
			t.Fatal("explicit edit target lost from frozen input")
		}
		return asset
	}
	first := generate("画一幅横版2048x1152的红色小屋和蓝色河流插画。这是独立新图。", "", nil)
	second := generate("全新独立创作，与之前图片无关，不使用旧图：画一幅2048x2048的黄色帆船插画。", "", nil)
	if first.ID == second.ID {
		t.Fatal("independent generation reused an old image")
	}
	download := func(asset entity.ChatMediaAsset) []byte {
		t.Helper()
		req, err := http.NewRequestWithContext(t.Context(), http.MethodGet,
			e.origin+"/api/v1/chats/"+chatID+"/sessions/"+sessionID+"/media/"+asset.ID+"."+map[string]string{
				"image/png": "png", "image/jpeg": "jpg", "image/webp": "webp"}[asset.MIMEType], nil)
		if err != nil {
			t.Fatal(err)
		}
		req.Header.Set("Authorization", e.token)
		response, err := e.client.Do(req)
		if err != nil {
			t.Fatal("real image download failed")
		}
		defer response.Body.Close()
		data, err := io.ReadAll(io.LimitReader(response.Body, chatMediaMaxBytes+1))
		dimensions, _, decodeErr := image.DecodeConfig(bytes.NewReader(data))
		if err != nil || response.StatusCode != 200 || len(data) > chatMediaMaxBytes || decodeErr != nil ||
			dimensions.Width != asset.Width || dimensions.Height != asset.Height {
			t.Fatal("downloaded image differs from persisted dimensions")
		}
		return data
	}
	base := download(first)
	refs := make([]chatUploadFile, 0, 2)
	for i, value := range []color.RGBA{{R: 190, G: 220, B: 240, A: 255}, {R: 245, G: 200, B: 80, A: 255}} {
		img := image.NewRGBA(image.Rect(0, 0, 160, 120))
		for y := range img.Bounds().Dy() {
			for x := range img.Bounds().Dx() {
				img.SetRGBA(x, y, value)
			}
		}
		var encoded bytes.Buffer
		if err := png.Encode(&encoded, img); err != nil {
			t.Fatal(err)
		}
		refs = append(refs, chatUploadFile{name: fmt.Sprintf("reference-%d.png", i+1), data: encoded.Bytes()})
	}
	uploads := e.uploadFiles(refs...)
	edited := generate("只编辑已选定的较早红色小屋图片，把背景改成绿色。保持底图实际尺寸，人物和小屋不变。"+
		"参考附件1的蓝色色调和附件2的黄色点缀。不改最新的帆船图。", first.ID, uploads)
	if edited.Width != first.Width || edited.Height != first.Height {
		t.Fatal("editing the older image changed its actual dimensions")
	}
	download(edited)
	req, err := http.NewRequestWithContext(t.Context(), http.MethodGet,
		"http://host.docker.internal:19982/observations", nil)
	if err != nil {
		t.Fatal(err)
	}
	response, err := e.client.Do(req)
	if err != nil {
		t.Fatal("image request observation unavailable")
	}
	defer response.Body.Close()
	var observations []chatImageObservation
	if response.StatusCode != 200 || json.NewDecoder(response.Body).Decode(&observations) != nil || len(observations) < 3 {
		t.Fatal("missing actual forwarded image request evidence")
	}
	observations = observations[len(observations)-3:]
	wantHashes := make([]string, 0, 3)
	for _, data := range [][]byte{base, refs[0].data, refs[1].data} {
		hash := sha256.Sum256(data)
		wantHashes = append(wantHashes, hex.EncodeToString(hash[:]))
	}
	if observations[0].Path != "/v1/images/generations" || observations[1].Path != "/v1/images/generations" ||
		observations[2].Path != "/v1/images/edits" ||
		observations[2].Size != fmt.Sprintf("%dx%d", first.Width, first.Height) ||
		!reflect.DeepEqual(observations[2].Hashes, wantHashes) {
		t.Fatalf("actual upstream target/reference order changed: %+v", observations)
	}
	var parents []entity.ChatMediaReference
	if err := db.Where("owner_kind = ? AND owner_id IN ?", "parent", []string{first.ID, second.ID, edited.ID}).
		Find(&parents).Error; err != nil || len(parents) != 1 || parents[0].AssetID != first.ID || parents[0].OwnerID != edited.ID {
		t.Fatal("independent images or selected edit have incorrect version references")
	}
	after := e.mediaControl(control, 0)
	if after["forwarded"] != before["forwarded"]+3 || after["rejected"] != before["rejected"] {
		t.Fatal("image workflow made unexpected external generation calls")
	}
	t.Logf("PASS real generations=2 edits=1; independent parents empty; explicit older parent=%s differs from latest=%s; real multipart SHA256 order=base,reference1,reference2; dimensions=%dx%d",
		first.ID, second.ID, edited.Width, edited.Height)
}
