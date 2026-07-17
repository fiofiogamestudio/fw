set windows-shell := ["powershell.exe", "-NoLogo", "-NoProfile", "-Command"]

default: build

gen:
    just gen_system
    just gen_bridge
    just gen_config

gen_system:
    powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File ".\\fw\\tools\\gen.ps1" system

gen_bridge:
    powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File ".\\fw\\tools\\gen.ps1" bridge

gen_config:
    powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File ".\\fw\\tools\\gen.ps1" config

config_check:
    powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File ".\\fw\\tools\\gen.ps1" config_check

config_pack:
    powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File ".\\fw\\tools\\gen.ps1" config_pack

check:
    powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File ".\\fw\\tools\\gen.ps1" check

test:
    powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File ".\\fw\\tools\\test.ps1"

build:
    powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File ".\\fw\\tools\\build.ps1"

build-release:
    powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File ".\\fw\\tools\\build.ps1" -Release
