#!/bin/sh
cd "$(dirname "$0")"; pkill -f '[m]ock_model.py'; (nohup python3 mock_model.py mock.log >/dev/null 2>&1 &); sleep 1
