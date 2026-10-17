package cronreporter

import (
	"bytes"
	"context"
	"crypto/tls"
	"crypto/x509"
	"encoding/json"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/url"
	"os"
	"strings"
	"time"
)

// The in-cluster service-account mount. The token is re-read on every request:
// bound service-account tokens rotate (hourly by default) and a token cached at
// startup would start 401ing after the first rotation.
const (
	saDir           = "/var/run/secrets/kubernetes.io/serviceaccount"
	saTokenFile     = saDir + "/token"
	saCAFile        = saDir + "/ca.crt"
	saNamespaceFile = saDir + "/namespace"
)

// cluster is the slice of the Kubernetes API the reporter uses. An interface so
// the reconcile logic is tested against a fake rather than a live apiserver.
type cluster interface {
	ListJobs(ctx context.Context, labelSelector string) ([]kjob, error)
	AnnotateJob(ctx context.Context, name string, annotations map[string]string) error
	ListJobPods(ctx context.Context, jobName string) ([]kpod, error)
	PodLogTail(ctx context.Context, pod, container string, lines, limitBytes int) (string, error)
}

// kjob is the subset of batch/v1 Job the reporter reads. Decoding into a narrow
// struct keeps the binary free of client-go (and the dependency tree it drags
// into the shared services module) for four REST calls.
type kjob struct {
	Metadata struct {
		Name              string            `json:"name"`
		UID               string            `json:"uid"`
		Labels            map[string]string `json:"labels"`
		Annotations       map[string]string `json:"annotations"`
		CreationTimestamp time.Time         `json:"creationTimestamp"`
	} `json:"metadata"`
	Status struct {
		StartTime      *time.Time      `json:"startTime"`
		CompletionTime *time.Time      `json:"completionTime"`
		Active         int32           `json:"active"`
		Succeeded      int32           `json:"succeeded"`
		Failed         int32           `json:"failed"`
		Conditions     []kjobCondition `json:"conditions"`
	} `json:"status"`
}

type kjobCondition struct {
	Type               string    `json:"type"`
	Status             string    `json:"status"`
	Reason             string    `json:"reason"`
	Message            string    `json:"message"`
	LastTransitionTime time.Time `json:"lastTransitionTime"`
}

type kpod struct {
	Metadata struct {
		Name              string    `json:"name"`
		CreationTimestamp time.Time `json:"creationTimestamp"`
	} `json:"metadata"`
	Status struct {
		Phase             string             `json:"phase"`
		Reason            string             `json:"reason"`
		Message           string             `json:"message"`
		ContainerStatuses []kcontainerStatus `json:"containerStatuses"`
	} `json:"status"`
}

type kcontainerStatus struct {
	Name      string          `json:"name"`
	State     kcontainerState `json:"state"`
	LastState kcontainerState `json:"lastState"`
}

type kcontainerState struct {
	Terminated *struct {
		ExitCode int32  `json:"exitCode"`
		Reason   string `json:"reason"`
		Message  string `json:"message"`
	} `json:"terminated"`
}

// kubeClient is a minimal in-cluster REST client scoped to one namespace.
type kubeClient struct {
	base      string
	namespace string
	tokenFile string
	http      *http.Client
}

func newInClusterClient(namespace string) (*kubeClient, error) {
	host, port := os.Getenv("KUBERNETES_SERVICE_HOST"), os.Getenv("KUBERNETES_SERVICE_PORT")
	if host == "" || port == "" {
		return nil, fmt.Errorf("not running in a cluster: KUBERNETES_SERVICE_HOST/PORT unset")
	}
	ca, err := os.ReadFile(saCAFile)
	if err != nil {
		return nil, fmt.Errorf("read service-account CA: %w", err)
	}
	pool := x509.NewCertPool()
	if !pool.AppendCertsFromPEM(ca) {
		return nil, fmt.Errorf("service-account CA %s holds no certificates", saCAFile)
	}
	if namespace == "" {
		raw, err := os.ReadFile(saNamespaceFile)
		if err != nil {
			return nil, fmt.Errorf("resolve namespace: %w", err)
		}
		namespace = strings.TrimSpace(string(raw))
	}
	return &kubeClient{
		base:      "https://" + net.JoinHostPort(host, port),
		namespace: namespace,
		tokenFile: saTokenFile,
		http: &http.Client{
			Timeout: 30 * time.Second,
			Transport: &http.Transport{
				TLSClientConfig: &tls.Config{RootCAs: pool, MinVersion: tls.VersionTLS12},
			},
		},
	}, nil
}

func (k *kubeClient) do(ctx context.Context, method, path, contentType string, body []byte) ([]byte, error) {
	token, err := os.ReadFile(k.tokenFile)
	if err != nil {
		return nil, fmt.Errorf("read service-account token: %w", err)
	}
	var reader io.Reader
	if body != nil {
		reader = bytes.NewReader(body)
	}
	req, err := http.NewRequestWithContext(ctx, method, k.base+path, reader)
	if err != nil {
		return nil, err
	}
	req.Header.Set("Authorization", "Bearer "+strings.TrimSpace(string(token)))
	req.Header.Set("Accept", "application/json")
	if contentType != "" {
		req.Header.Set("Content-Type", contentType)
	}
	resp, err := k.http.Do(req)
	if err != nil {
		return nil, err
	}
	defer func() { _ = resp.Body.Close() }()
	out, err := io.ReadAll(io.LimitReader(resp.Body, 32<<20))
	if err != nil {
		return nil, err
	}
	if resp.StatusCode/100 != 2 {
		return nil, fmt.Errorf("%s %s: %s: %s", method, path, resp.Status, truncate(string(out), 300))
	}
	return out, nil
}

func (k *kubeClient) ListJobs(ctx context.Context, labelSelector string) ([]kjob, error) {
	path := fmt.Sprintf("/apis/batch/v1/namespaces/%s/jobs?labelSelector=%s", k.namespace, url.QueryEscape(labelSelector))
	raw, err := k.do(ctx, http.MethodGet, path, "", nil)
	if err != nil {
		return nil, err
	}
	var list struct {
		Items []kjob `json:"items"`
	}
	if err := json.Unmarshal(raw, &list); err != nil {
		return nil, fmt.Errorf("decode job list: %w", err)
	}
	return list.Items, nil
}

func (k *kubeClient) AnnotateJob(ctx context.Context, name string, annotations map[string]string) error {
	patch, err := json.Marshal(map[string]any{"metadata": map[string]any{"annotations": annotations}})
	if err != nil {
		return err
	}
	path := fmt.Sprintf("/apis/batch/v1/namespaces/%s/jobs/%s", k.namespace, url.PathEscape(name))
	_, err = k.do(ctx, http.MethodPatch, path, "application/merge-patch+json", patch)
	return err
}

func (k *kubeClient) ListJobPods(ctx context.Context, jobName string) ([]kpod, error) {
	selector := jobNamePodLabel + "=" + jobName
	path := fmt.Sprintf("/api/v1/namespaces/%s/pods?labelSelector=%s", k.namespace, url.QueryEscape(selector))
	raw, err := k.do(ctx, http.MethodGet, path, "", nil)
	if err != nil {
		return nil, err
	}
	var list struct {
		Items []kpod `json:"items"`
	}
	if err := json.Unmarshal(raw, &list); err != nil {
		return nil, fmt.Errorf("decode pod list: %w", err)
	}
	return list.Items, nil
}

func (k *kubeClient) PodLogTail(ctx context.Context, pod, container string, lines, limitBytes int) (string, error) {
	q := url.Values{}
	q.Set("container", container)
	q.Set("tailLines", fmt.Sprint(lines))
	q.Set("limitBytes", fmt.Sprint(limitBytes))
	path := fmt.Sprintf("/api/v1/namespaces/%s/pods/%s/log?%s", k.namespace, url.PathEscape(pod), q.Encode())
	raw, err := k.do(ctx, http.MethodGet, path, "", nil)
	if err != nil {
		return "", err
	}
	return string(raw), nil
}

func truncate(s string, n int) string {
	if len(s) <= n {
		return s
	}
	return s[:n] + "…"
}
