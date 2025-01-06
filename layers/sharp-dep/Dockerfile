FROM amazonlinux:nodejs

# install dependencies
RUN yum install -y make && npm install --production
RUN yum -y install zip

# # create directories
# RUN mkdir /app /build

# # copy source code
# COPY ./app/* /app/

# # install npm dependencies
# WORKDIR /app
# RUN npm install

# # build app
# WORKDIR /app
RUN zip -r build.zip .

# put container to sleep in order to copy the build
CMD sleep 10m
