#!/bin/bash

# Ensure root
if [[ $EUID -ne 0 ]]
then
	>&2 echo "You must be root to install the chrome-cmd service"
	exit 1
fi

# Move into script directory
base_dir=$(dirname "${BASH_SOURCE[0]}")
cd "$base_dir"

# Create chrome-cmd user if needed
if [ -z "$(id -u chrome-cmd)" &> /dev/null ]
then
	echo "creating user chrome-cmd"
	useradd --system --no-create-home --shell "/bin/false" chrome-cmd
	nobody_home=~nobody
	if [ -n "$nobody_home" ]
	then
		usermod -d "$nobody_home" chrome-cmd
	fi
fi

# Install service
cp "chrome-cmd.service" "/etc/init.d/chrome-cmd"
update-rc.d chrome-cmd defaults
