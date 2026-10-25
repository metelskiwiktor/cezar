# Cienkie przekazanie do cezar-adapter, który trzyma operacje na usługach Servy (Tabnote-cezar / -adapter).
# Ścieżka adaptera: ../cezar-adapter albo CEZAR_ADAPTER_REPO. Szczegóły: `just --list` w cezar-adapter.
# Start/stop usługi nie wymaga administratora (UAC tylko awaryjnie). Obejście blokady aktywnych tasków: `just force=1 deploy`.

set windows-shell := ["pwsh.exe", "-NoLogo", "-NoProfile", "-Command"]
set quiet

adapter := env("CEZAR_ADAPTER_REPO", "../cezar-adapter")
force := ""

default:
    @just --list --unsorted

# Stan usług, wersji i aktywnych tasków (Cezar + adapter)
status:
    just --justfile {{adapter}}/justfile status

# Build -> `cezar install` -> restart Tabnote-cezar z tego checkoutu
deploy:
    just --justfile {{adapter}}/justfile force={{force}} cezar-deploy

# Tylko build (bez instalacji i restartu)
build:
    just --justfile {{adapter}}/justfile cezar-build

# Wróć do poprzedniej wersji Cezara i zrestartuj
rollback id="":
    just --justfile {{adapter}}/justfile force={{force}} cezar-rollback {{id}}

# Ostatnie logi usługi: cezar | adapter | tunnel
logs service="cezar":
    just --justfile {{adapter}}/justfile logs {{service}}