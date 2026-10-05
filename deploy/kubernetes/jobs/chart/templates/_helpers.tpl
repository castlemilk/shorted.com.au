{{- define "shorted-jobs.labels" -}}
app.kubernetes.io/part-of: shorted
app.kubernetes.io/managed-by: {{ .Release.Service }}
helm.sh/chart: {{ printf "%s-%s" .Chart.Name .Chart.Version | replace "+" "_" }}
{{- end -}}

{{/* Resolve `image: <key>` to repository:tag, failing the render on a typo. */}}
{{- define "shorted-jobs.image" -}}
{{- $img := index .root.Values.images .key -}}
{{- if not $img -}}
{{- fail (printf "unknown image key %q (valid: %s)" .key (keys .root.Values.images | sortAlpha | join ", ")) -}}
{{- end -}}
{{- if not $img.tag -}}
{{- fail (printf "images.%s.tag is empty — pin an immutable tag" .key) -}}
{{- end -}}
{{- printf "%s:%s" $img.repository $img.tag -}}
{{- end -}}

{{/* A Google SA email -> short, stable name for its KSA + credential ConfigMap. */}}
{{- define "shorted-jobs.wifName" -}}
{{- printf "wif-%s" (splitList "@" . | first) | trunc 63 | trimSuffix "-" -}}
{{- end -}}

{{- define "shorted-jobs.wifAudience" -}}
{{- $wi := . -}}
{{- printf "//iam.googleapis.com/projects/%s/locations/global/workloadIdentityPools/%s/providers/%s" (toString $wi.projectNumber) $wi.pool $wi.provider -}}
{{- end -}}

{{/*
Merged env for a job: commonEnv, then each profile in order, then the job's
own env. Returns YAML {env: {...}, secretEnv: {...}} for fromYaml.
*/}}
{{- define "shorted-jobs.mergedEnv" -}}
{{- $root := .root -}}
{{- $job := .job -}}
{{- $env := deepCopy ($root.Values.commonEnv | default dict) -}}
{{- $secretEnv := dict -}}
{{- range $p := ($job.profiles | default list) -}}
{{- $profile := index $root.Values.profiles $p -}}
{{- if not $profile -}}
{{- fail (printf "job %q references unknown profile %q" $.name $p) -}}
{{- end -}}
{{- $env = merge (deepCopy ($profile.env | default dict)) $env -}}
{{- $secretEnv = merge (deepCopy ($profile.secretEnv | default dict)) $secretEnv -}}
{{- end -}}
{{- $env = merge (deepCopy ($job.env | default dict)) $env -}}
{{- $secretEnv = merge (deepCopy ($job.secretEnv | default dict)) $secretEnv -}}
{{- range $k, $_ := $env -}}
{{- if hasKey $secretEnv $k -}}
{{- fail (printf "job %q sets %s as both plain and secret env" $.name $k) -}}
{{- end -}}
{{- end -}}
{{- dict "env" $env "secretEnv" $secretEnv | toYaml -}}
{{- end -}}
