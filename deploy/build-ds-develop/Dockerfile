# Document Server "develop" image — builds mounted sdkjs/web-apps/server
# against the prebuilt core from the base documentserver image (no C++/Qt build).
#
# Vendored from ONLYOFFICE/build_tools develop/Dockerfile (master) so the build
# is reproducible and reviewable. Use with build-ds-develop.sh.
#
# NOTE: bases on the OFFICIAL onlyoffice/documentserver image, NOT the
# Euro-Office fork — the stock develop entrypoint expects the onlyoffice layout
# (/var/www/onlyoffice/... and /app/ds/run-document-server.sh), which the fork
# renames. This image is for validating from-source JS builds (does our sdkjs
# cursor method compile into an interchangeable bundle), not a drop-in prod image.
ARG DOCUMENTSERVER_IMAGE=onlyoffice/documentserver:latest
FROM ${DOCUMENTSERVER_IMAGE}
ARG BUILDTOOLS_BRANCH=
RUN apt-get update -y && \
	apt-get install git -y \
			python3 -y \
			openjdk-11-jdk -y \
			bzip2 -y \
			npm -y && \
	npm install -g grunt grunt-cli -y && \
	ln -s /usr/bin/python3 /usr/bin/python && \
	ln -s /usr/bin/pip3 /usr/bin/pip && \
	git clone --depth 1 ${BUILDTOOLS_BRANCH:+--branch ${BUILDTOOLS_BRANCH}} https://github.com/ONLYOFFICE/build_tools.git var/www/onlyoffice/documentserver/build_tools && \
	sed -i '/documentserver-static-gzip.sh ${ONLYOFFICE_DATA_CONTAINER}/d' /app/ds/run-document-server.sh && \
	sed -i 's/WARN/ALL/g' /etc/onlyoffice/documentserver/log4js/production.json && \
	if [ -s /etc/supervisor/conf.d/ds-example.conf ] ; then sed -i 's,autostart=false,autostart=true,' /etc/supervisor/conf.d/ds-example.conf; fi && \
	if [ -s /app/ds/setup/config/supervisor/ds/ds-example.conf ] ; then sed -i 's,autostart=false,autostart=true,' /app/ds/setup/config/supervisor/ds/ds-example.conf; fi && \
	rm -rf /var/lib/apt/lists/*
# run_build_js.py is fetched from build_tools inside the image; the stock
# Dockerfile COPYs a local copy over it, but build_tools already ships it, so we
# rely on the cloned one via the entrypoint below.
ENTRYPOINT python3 /var/www/onlyoffice/documentserver/build_tools/develop/run_build_js.py /var/www/onlyoffice/documentserver $@ && /bin/sh -c /app/ds/run-document-server.sh
